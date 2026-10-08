// KeywordBankBuilder — orchestrates the full keyword-bank lifecycle: resolve
// the source text, hash it, skip Gemini entirely if unchanged, otherwise fetch
// the current question bank, prompt Gemini, validate, and write to Firestore.
// Thin coordinator, same role as lib/hermesAgent.js plays for question
// generation — every step below is delegated to a focused module.
//
// KEYED BY assessment_id (docs/AUDIT.md section H, item 4). The bank used to
// live at keywordBanks/{unit}, where `unit` was a bare roman numeral, so two
// subjects that both had a "Unit I" shared one grading rubric and the second
// one generated silently overwrote the first. The document id is now the
// globally-unique assessment_id. Legacy unit-keyed documents are left in place
// and still read — see the fallback in api/grade-open-ended.js — so banks
// generated before this change keep grading until they are regenerated.

const crypto = require("crypto");
const { getConfig } = require("./config");
const { extractText } = require("./documentTextExtractor");
const { fetchQuestionBank, fetchSyllabusContext } = require("./githubRetriever");
const { buildKeywordPrompt } = require("./keywordPromptBuilder");
const { callGemini } = require("./llmService");
const { validate } = require("./keywordBankValidator");
const { getFirestore } = require("./firebaseAdmin");
const { getMaterial } = require("./materialStore");
const { resolveAssessment, questionBankRepoPath } = require("./registryStore");
const AssessmentRegistry = require("./assessmentRegistry");
const admin = require("firebase-admin");

const COLLECTION = "keywordBanks";

// Bumped when the stored entry shape changes. 1 = pre-required/optional banks
// (no `required` field on keywords, keyed by unit); 2 = keyed by assessment_id,
// keywords carry `required`. lib/keywordMatcher.js does not read this — it
// keys off the presence of `required: true` itself — but the dashboard and any
// future migration need to tell the two apart.
const SCHEMA_VERSION = 2;

const OPEN_ENDED_TYPES = ["descriptive", "scenario", "promptengineering"];

function isOpenEnded(q) {
  if (OPEN_ENDED_TYPES.includes(q.type)) return true;
  // "debugging" is open-ended only when it has no closed-form acceptableAnswers.
  return q.type === "debugging" && !(Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length > 0);
}

function normalizeSyllabusText(text) {
  return (text || "").trim().replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
}

function hashSyllabusText(text) {
  return crypto.createHash("sha256").update(normalizeSyllabusText(text), "utf8").digest("hex");
}

async function parseKeywordBankObject(prompt, config) {
  let lastError;
  let currentPrompt = prompt;

  for (let attempt = 0; attempt <= config.llmMaxRetries; attempt++) {
    try {
      const text = await callGemini(currentPrompt, config);
      const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response was not a JSON object");
      }
      return parsed;
    } catch (err) {
      lastError = err;
      currentPrompt = `${prompt}\n\nYour previous response was rejected: ${err.message}\nReturn ONLY a single valid JSON object this time, with no commentary and no markdown code fences.`;
    }
  }
  throw new Error(`Gemini did not return a valid JSON object after ${config.llmMaxRetries + 1} attempts: ${lastError.message}`);
}

/**
 * Establishes what this run is FOR, from either identifier:
 *
 *   assessment_id — the new form. Resolves through the registry, which supplies
 *                   the unit's legacy key, the question bank behind the
 *                   assessment, and any attached material, so the caller needs
 *                   to send nothing else.
 *   unit          — the legacy form, kept so teacher.html's existing Step 5
 *                   flow (a unit dropdown and a file picker) keeps working
 *                   unchanged. Writes to the legacy unit-keyed document.
 *
 * Returns { bankId, assessment_id, subject_id, unit_id, unit, unitTitle,
 *           subjectName, assessmentTitle, entry }, where `entry` is the
 * registry entry or null for the legacy form.
 */
function resolveTarget(payload) {
  if (payload.assessment_id) {
    const entry = resolveAssessment(payload.assessment_id);
    const { subject, unit, assessment } = entry;
    return {
      bankId: assessment.assessment_id,
      assessment_id: assessment.assessment_id,
      subject_id: subject.subject_id,
      unit_id: unit.unit_id,
      // The bare roman numeral, still needed: every question in a committed
      // bank carries `unit: "I"`, and the legacy fallback paths are built from it.
      unit: unit.legacy_unit_key || "",
      unitTitle: unit.title || unit.name || "",
      subjectName: subject.name || "",
      assessmentTitle: assessment.title || "",
      entry,
    };
  }

  if (!payload.unit) {
    const err = new Error("Provide assessment_id (preferred), or unit for the legacy flow.");
    err.statusCode = 400;
    throw err;
  }

  return {
    bankId: payload.unit,
    assessment_id: null,
    subject_id: null,
    unit_id: null,
    unit: payload.unit,
    unitTitle: payload.unitTitle || "",
    subjectName: "",
    assessmentTitle: "",
    entry: null,
  };
}

/**
 * Resolves the syllabus text for this run, in priority order:
 *   1. payload.material_id — already-uploaded material (lib/materialStore.js).
 *   2. payload.fileBase64  — a direct upload, the original behaviour.
 *   3. the assessment's own material / legacy syllabus path, from the registry.
 *
 * 3 is what makes the assessment_id form self-sufficient: an assessment whose
 * unit already points at stored material (or at a committed syllabus path)
 * needs no file sent with the request at all. Nothing is re-uploaded or
 * re-parsed for case 1 or 3 — the text was extracted once, at upload.
 */
async function resolveSyllabusText(payload, target) {
  if (payload.material_id) {
    const material = await getMaterial(payload.material_id);
    if (!material.extracted_text) {
      const err = new Error(`Material "${payload.material_id}" has no extracted text to build a keyword bank from.`);
      err.statusCode = 400;
      throw err;
    }
    return { text: material.extracted_text, source: { kind: "material", material_id: payload.material_id } };
  }

  if (payload.fileBase64 && payload.filename) {
    // extractText returns { text, extension, charCount } — the extra fields are
    // unused here, but the destructure must stay in step with the extractor.
    const { text } = await extractText(payload.fileBase64, payload.filename);
    return { text, source: { kind: "upload", filename: payload.filename } };
  }

  if (target.entry) {
    const sources = AssessmentRegistry.resolveMaterialSources(target.entry);
    const config = getConfig();
    for (const source of sources) {
      if (source.kind === "material") {
        const material = await getMaterial(source.material_id);
        if (material.extracted_text) {
          return { text: material.extracted_text, source };
        }
      } else if (source.kind === "repo-path") {
        return { text: await fetchSyllabusContext(target.unit, config, source.path), source };
      }
    }
    const err = new Error(
      `Assessment "${target.assessment_id}" has no material to build a keyword bank from. ` +
      `Upload material for its unit first, or send material_id / fileBase64 with this request.`
    );
    err.statusCode = 400;
    throw err;
  }

  const err = new Error("Provide either material_id, or fileBase64 + filename.");
  err.statusCode = 400;
  throw err;
}

/**
 * The open-ended questions this bank must cover. Reads whichever bank the
 * assessment actually points at — a committed repo path or a Firestore bank
 * written by the editor — rather than deriving a filename from the unit number,
 * which is what lib/githubRetriever.js used to do for everything.
 */
async function fetchOpenEndedQuestions(target, config, db) {
  const ref = target.entry && target.entry.assessment.question_bank_ref;

  if (typeof ref === "string" && ref.startsWith("firestore:")) {
    const bankId = ref.slice("firestore:".length);
    const snap = await db.collection("questionBanks").doc(bankId).get();
    if (!snap.exists) {
      const err = new Error(`Question bank "${bankId}" does not exist in Firestore.`);
      err.statusCode = 404;
      throw err;
    }
    return (snap.data().questions || []).filter(isOpenEnded);
  }

  const repoPath = target.entry ? questionBankRepoPath(target.entry) : null;
  const all = await fetchQuestionBank(target.unit, config, repoPath);
  return all.filter(isOpenEnded);
}

// payload: { assessment_id | unit, unitTitle?, forceRegenerate?, and optionally
//            material_id or fileBase64+filename }
// teacherEmail: the verified caller, stamped onto the stored bank as generatedBy.
// Returns { skipped, bankId, entries, dropped, warnings, coverage, model } — throws
// on unrecoverable errors.
async function buildKeywordBank(payload, teacherEmail) {
  const config = getConfig();
  const db = getFirestore();

  if (!payload) {
    const err = new Error("Provide assessment_id (preferred), or unit for the legacy flow.");
    err.statusCode = 400;
    throw err;
  }

  const target = resolveTarget(payload);
  const { text: rawText, source } = await resolveSyllabusText(payload, target);
  const sourceContentHash = hashSyllabusText(rawText);

  const docRef = db.collection(COLLECTION).doc(target.bankId);
  const existing = await docRef.get();
  if (
    existing.exists &&
    !payload.forceRegenerate &&
    existing.data().sourceContentHash === sourceContentHash &&
    // A v1 document predates required/optional flags. Leaving it in place
    // because the source text happens to be unchanged would mean an assessment
    // never gets the stricter rubric without someone remembering to tick
    // "force regenerate" — so a schema upgrade counts as a reason to rebuild.
    existing.data().schemaVersion === SCHEMA_VERSION
  ) {
    return {
      skipped: true,
      bankId: target.bankId,
      reason: "Syllabus content is unchanged since the last generation — skipped calling Gemini.",
      entries: existing.data().entries || {},
      generatedAt: existing.data().generatedAt,
    };
  }

  const openEnded = await fetchOpenEndedQuestions(target, config, db);
  if (openEnded.length === 0) {
    const scope = target.assessment_id ? `assessment "${target.assessment_id}"` : `Unit ${target.unit}`;
    const err = new Error(
      `No descriptive/scenario/prompt-engineering/open-debugging questions found for ${scope} — nothing to generate keywords for.`
    );
    err.statusCode = 400;
    throw err;
  }

  const prompt = buildKeywordPrompt({
    syllabusText: rawText,
    unit: target.unit,
    unitTitle: target.unitTitle,
    subjectName: target.subjectName,
    assessmentTitle: target.assessmentTitle,
    questions: openEnded.map((q) => ({ id: q.id, topic: q.topic, question: q.question })),
  });

  const rawBank = await parseKeywordBankObject(prompt, config);
  const validQuestionIds = new Set(openEnded.map((q) => q.id));
  const { entries, dropped, warnings } = validate(rawBank, validQuestionIds);

  // Merge topic/questionText from the real question bank into each entry —
  // Gemini's response only carries keywords, per the prompt's schema.
  const questionById = new Map(openEnded.map((q) => [q.id, q]));
  for (const [questionId, entry] of Object.entries(entries)) {
    const q = questionById.get(questionId);
    entry.topic = q.topic;
    entry.questionText = q.question;
  }

  await docRef.set({
    schemaVersion: SCHEMA_VERSION,
    // Both identities are stored. assessment_id is the real key; unit is kept
    // so a legacy bank can be recognised and so the dashboard can group by it.
    assessment_id: target.assessment_id,
    subject_id: target.subject_id,
    unit_id: target.unit_id,
    unit: target.unit,
    unitTitle: target.unitTitle,
    sourceContentHash,
    sourceRef: source,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    generatedBy: teacherEmail,
    model: config.geminiModel,
    entries,
  });

  const requiredTotal = Object.values(entries).reduce((s, e) => s + (e.requiredCount || 0), 0);

  return {
    skipped: false,
    bankId: target.bankId,
    entries,
    dropped,
    warnings,
    coverage: {
      requested: openEnded.length,
      generated: Object.keys(entries).length,
      droppedCount: dropped.length,
      requiredConcepts: requiredTotal,
    },
    model: config.geminiModel,
  };
}

module.exports = { buildKeywordBank, hashSyllabusText, isOpenEnded, SCHEMA_VERSION, COLLECTION };
