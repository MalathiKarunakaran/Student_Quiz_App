// MaterialStore — the persistence layer for uploaded assessment material.
// Answers the §6 question "WHERE are uploaded assessment files stored?",
// which before this module had the answer "nowhere" (docs/AUDIT.md section E):
// lib/keywordBankBuilder.js extracted a file's text, hashed it, used it once
// and discarded both.
//
// TWO STORES, because the two halves have very different shapes:
//   - Firebase Storage  — the original bytes, under materials/{material_id}/{filename}.
//     A PDF is routinely several MB; a Firestore document is capped at ~1 MiB.
//   - Firestore `materials/{material_id}` — extracted text, derived metadata,
//     lifecycle status, and provenance. Queryable; the bytes are not.
//
// The bucket has existed in js/firebase-config.js since the project was set up
// and has never been written to. This module is its first use, which is why
// storage.rules is new in the same change.
//
// ADMIN SDK ONLY. Every function here runs server-side behind a verified
// teacher token (lib/firebaseAdmin.js verifyTeacherToken), bypassing the
// client rules the same way api/grade-open-ended.js already does for keyword
// banks. Uploaded material is never world-readable: it is the source the
// answer key is derived from, so it inherits the keyword bank's trust level,
// not the question bank's (see the asymmetry note in firestore.rules).

const crypto = require("crypto");
const admin = require("firebase-admin");
const { getAdminApp, getFirestore } = require("./firebaseAdmin");

const COLLECTION = "materials";

// Mirrors the assessment lifecycle in lib/assessmentRegistry.js, one step
// behind it: material must reach `processed` before an assessment built on it
// can leave `draft`. §3's "do not generate the quiz immediately after upload".
const STATUSES = ["uploaded", "processing", "processed", "failed", "archived"];

// Extension → what Firebase Storage should serve the bytes back as.
const CONTENT_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
};

// Firestore caps a document at ~1 MiB. Extracted text from a large PDF can
// approach that on its own, so it is capped well below and the overflow kept
// only in the stored original. Generation prompts truncate at a lower bound
// anyway (lib/materialProcessor.js MAX_PROMPT_CHARS).
const MAX_INLINE_TEXT_CHARS = 400000;

function contentTypeFor(extension) {
  return CONTENT_TYPES[extension] || "application/octet-stream";
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "").trim().replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * Material ids are generated, not derived from the filename: two units can
 * legitimately both have an "Unit1_Syllabus.pdf", and a filename is not a safe
 * document id anyway (spaces, slashes, non-ASCII).
 */
function newMaterialId() {
  return `mat-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Strips anything that would be unsafe in a Storage object path. */
function safeFilename(filename) {
  const cleaned = String(filename || "material")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(-120);
  return cleaned || "material";
}

function bucket() {
  // getAdminApp() initialises from FIREBASE_SERVICE_ACCOUNT_BASE64, whose
  // project implies the default bucket — so no bucket name is configured
  // separately here, and there is nothing to keep in sync with the client's
  // js/firebase-config.js storageBucket value.
  return getAdminApp().storage().bucket();
}

/**
 * Writes the original bytes to Storage and the derived record to Firestore.
 *
 * params: { subject_id, unit_id, assessment_id?, filename, extension,
 *           buffer, text, uploadedBy, title? }
 * Returns the stored material record.
 */
async function saveMaterial(params) {
  const materialId = params.material_id || newMaterialId();
  const filename = safeFilename(params.filename);
  const objectPath = `${COLLECTION}/${materialId}/${filename}`;

  await bucket().file(objectPath).save(params.buffer, {
    contentType: contentTypeFor(params.extension),
    resumable: false, // single-shot upload; these files are MBs, not GBs
    metadata: {
      metadata: {
        material_id: materialId,
        subject_id: params.subject_id || "",
        unit_id: params.unit_id || "",
        uploaded_by: params.uploadedBy || "",
      },
    },
  });

  const fullText = params.text || "";
  const textTruncated = fullText.length > MAX_INLINE_TEXT_CHARS;

  const record = {
    material_id: materialId,
    subject_id: params.subject_id || "",
    unit_id: params.unit_id || "",
    assessment_id: params.assessment_id || null,
    title: params.title || params.filename || filename,
    filename: params.filename || filename,
    extension: params.extension,
    storage_path: objectPath,
    size_bytes: params.buffer.length,
    char_count: fullText.length,
    extracted_text: textTruncated ? fullText.slice(0, MAX_INLINE_TEXT_CHARS) : fullText,
    extracted_text_truncated: textTruncated,
    // Lets a re-upload of an unchanged file skip reprocessing, the same
    // sourceContentHash trick lib/keywordBankBuilder.js already uses.
    content_hash: hashText(fullText),
    status: "uploaded",
    metadata: null,
    processing_warnings: [],
    uploaded_by: params.uploadedBy || "",
    uploaded_at: admin.firestore.FieldValue.serverTimestamp(),
    processed_at: null,
    processed_by: null,
  };

  await getFirestore().collection(COLLECTION).doc(materialId).set(record);
  return record;
}

async function getMaterial(materialId) {
  const snap = await getFirestore().collection(COLLECTION).doc(materialId).get();
  if (!snap.exists) {
    const err = new Error(`No material named "${materialId}" exists.`);
    err.statusCode = 404;
    throw err;
  }
  return snap.data();
}

/** Lists material records WITHOUT their extracted_text — that field dwarfs everything else. */
async function listMaterials(filters = {}) {
  let ref = getFirestore().collection(COLLECTION);
  if (filters.subject_id) ref = ref.where("subject_id", "==", filters.subject_id);
  if (filters.unit_id) ref = ref.where("unit_id", "==", filters.unit_id);
  if (filters.status) ref = ref.where("status", "==", filters.status);
  ref = ref.limit(filters.limit || 200);

  const snap = await ref.get();
  return snap.docs
    .map((d) => {
      const { extracted_text, ...rest } = d.data();
      return rest;
    })
    .sort((a, b) => String(b.material_id).localeCompare(String(a.material_id)));
}

async function setStatus(materialId, status, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown material status "${status}".`);
  await getFirestore().collection(COLLECTION).doc(materialId).update(Object.assign({ status }, extra));
}

/** Stores the §3 knowledge object and moves the material to `processed`. */
async function saveMetadata(materialId, { metadata, warnings, processedBy, model }) {
  await getFirestore().collection(COLLECTION).doc(materialId).update({
    metadata,
    processing_warnings: warnings || [],
    status: "processed",
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    processed_by: processedBy || "",
    processed_model: model || "",
  });
}

/**
 * A short-lived signed URL for the teacher to download/preview the original.
 *
 * Signed rather than public, and expiring, because §10 asks explicitly whether
 * students can download assessment material. They cannot: the bucket denies
 * all client access (storage.rules), and a URL only exists when a verified
 * teacher asks for one. It does mean anyone holding the URL within the window
 * can fetch it — so the window is deliberately short.
 */
async function getDownloadUrl(materialId, expiresInMinutes = 15) {
  const material = await getMaterial(materialId);
  const [url] = await bucket().file(material.storage_path).getSignedUrl({
    action: "read",
    expires: Date.now() + expiresInMinutes * 60 * 1000,
  });
  return { url, expiresInMinutes, filename: material.filename };
}

/** Removes both halves. Storage first: an orphaned record is recoverable, orphaned bytes are not findable. */
async function deleteMaterial(materialId) {
  const material = await getMaterial(materialId);
  await bucket().file(material.storage_path).delete({ ignoreNotFound: true });
  await getFirestore().collection(COLLECTION).doc(materialId).delete();
}

/** Finds an already-processed material with identical content, so a re-upload can reuse it. */
async function findByContentHash(contentHash, { subject_id, unit_id } = {}) {
  let ref = getFirestore().collection(COLLECTION).where("content_hash", "==", contentHash);
  if (subject_id) ref = ref.where("subject_id", "==", subject_id);
  if (unit_id) ref = ref.where("unit_id", "==", unit_id);
  const snap = await ref.limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}

module.exports = {
  saveMaterial, getMaterial, listMaterials, setStatus, saveMetadata,
  getDownloadUrl, deleteMaterial, findByContentHash,
  hashText, newMaterialId, safeFilename, contentTypeFor,
  COLLECTION, STATUSES, MAX_INLINE_TEXT_CHARS, CONTENT_TYPES,
};
