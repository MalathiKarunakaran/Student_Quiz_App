// Vercel serverless function — POST /api/upload-material
// Teacher-only. Accepts a base64 file, extracts its text, and stores both the
// original bytes (Firebase Storage) and the derived record (Firestore).
// Thin HTTP wrapper over lib/materialStore.js + lib/documentTextExtractor.js,
// mirroring api/generate-keywords.js's relationship to lib/keywordBankBuilder.js.
//
// DELIBERATELY DOES NOT PROCESS OR GENERATE ANYTHING. Requirement §3 is
// explicit that the flow is Upload → Process → Review → Publish, so this
// endpoint stops at `uploaded` and the teacher triggers /api/process-material
// separately. Chaining them here would collapse two of those four steps and
// bill a Gemini call on every upload, including the wrong-file ones.

const { verifyTeacherToken } = require("../lib/firebaseAdmin");
const { getFirebaseConfig } = require("../lib/config");
const { extractText, SUPPORTED_EXTENSIONS } = require("../lib/documentTextExtractor");
const MaterialStore = require("../lib/materialStore");

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  try {
    const decoded = await verifyTeacherToken(req.headers.authorization);
    const { subject_id, unit_id, assessment_id, filename, fileBase64, title, reuseIfUnchanged } = req.body || {};

    if (!filename || !fileBase64) throw badRequest("filename and fileBase64 are both required.");
    if (!subject_id || !unit_id) {
      // §2: material must be associated with a subject and unit. Without this
      // it is an orphan file that no assessment can ever resolve.
      throw badRequest("subject_id and unit_id are both required — material must be filed under a subject and unit.");
    }

    // Size is checked BEFORE extraction: parsing a 200MB PDF would blow the
    // function's memory limit long before any of our own code complained.
    const { maxSyllabusUploadBytes } = getFirebaseConfig();
    const approxBytes = Buffer.byteLength(fileBase64, "utf8") * 0.75;
    if (approxBytes > maxSyllabusUploadBytes) {
      const err = new Error(
        `File is too large (~${Math.round(approxBytes / 1024 / 1024)}MB, limit ` +
        `${Math.round(maxSyllabusUploadBytes / 1024 / 1024)}MB). Split it into per-unit files.`
      );
      err.statusCode = 413;
      throw err;
    }

    const { text, extension, charCount } = await extractText(fileBase64, filename);

    // A teacher re-uploading the same unchanged file for the same unit gets
    // the existing processed record back instead of a duplicate — the same
    // content-hash short-circuit lib/keywordBankBuilder.js uses to skip Gemini.
    if (reuseIfUnchanged !== false) {
      const existing = await MaterialStore.findByContentHash(
        MaterialStore.hashText(text), { subject_id, unit_id }
      );
      if (existing) {
        res.status(200).json({
          material: Object.assign({}, existing, { extracted_text: undefined }),
          reused: true,
          reason: "An identical file is already stored for this unit — reusing it instead of creating a duplicate.",
        });
        return;
      }
    }

    const buffer = Buffer.from(fileBase64, "base64");
    const record = await MaterialStore.saveMaterial({
      subject_id, unit_id,
      assessment_id: assessment_id || null,
      filename, extension, buffer, text,
      title: title || filename,
      uploadedBy: decoded.email,
    });

    res.status(200).json({
      // extracted_text is withheld from the response for the same reason
      // listMaterials() withholds it: it can be hundreds of KB, and the
      // upload UI only needs the identifiers and the counts.
      material: Object.assign({}, record, { extracted_text: undefined, uploaded_at: null }),
      reused: false,
      charCount,
      supportedExtensions: SUPPORTED_EXTENSIONS,
      nextStep: "Call /api/process-material with this material_id to extract topics, outcomes and concepts.",
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Upload failed." });
  }
};
