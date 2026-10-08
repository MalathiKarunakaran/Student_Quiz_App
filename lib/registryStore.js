// RegistryStore — server-side access to the assessment registry.
//
// lib/assessmentRegistry.js is pure schema and lookup: it knows how to
// validate a registry object and how to find things inside one, but never how
// to obtain one. The browser gets its copy through js/data-loader.js
// (fetch of data/assessments.json); this module is the equivalent for the
// serverless functions, which cannot fetch a relative path.
//
// WHY THIS EXISTS NOW. Keying the keyword bank by `assessment_id` instead of a
// bare unit (docs/AUDIT.md section H, item 4) means the server has to be able
// to turn an assessment_id into the things the generator needs — the unit's
// legacy key, the question bank behind the assessment, the material or
// syllabus path to read from. All three live in the registry, so the server
// needs to read it.
//
// SOURCE: the committed data/assessments.json, read from disk and cached for
// the lifetime of the warm Vercel instance. That file is the seed and static
// fallback (see its own _comment), and today it is also the only copy anything
// reads — the Firestore `assessments`/`subjects` collections exist in
// firestore.rules but nothing writes them yet. When api/assessments.js (section
// H item 6) starts writing them, this module is the one place that needs to
// learn to prefer Firestore; every caller below is already indirect through
// resolveAssessment().

const fs = require("fs");
const path = require("path");
const AssessmentRegistry = require("./assessmentRegistry");

// data/ sits next to lib/, one level up from this file.
const REGISTRY_FILE = path.join(__dirname, "..", "data", "assessments.json");

let cached = null;

/** The raw registry object. Cached — a warm instance re-reads nothing. */
function loadRegistry({ force = false } = {}) {
  if (cached && !force) return cached;

  let text;
  try {
    text = fs.readFileSync(REGISTRY_FILE, "utf8");
  } catch (e) {
    const err = new Error(
      `Could not read the assessment registry at data/assessments.json: ${e.message}`
    );
    err.statusCode = 500;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const err = new Error(`data/assessments.json is not valid JSON: ${e.message}`);
    err.statusCode = 500;
    throw err;
  }

  cached = parsed;
  return cached;
}

/**
 * assessment_id → { subject, unit, assessment }.
 *
 * Throws a 404-shaped error rather than returning null: every server caller
 * treats an unknown id as a request error, and throwing here keeps the
 * null-check out of each of them. Unlike the student-facing
 * DataLoader.configFromAssessmentId(), this does NOT require the assessment to
 * be published — a teacher generating a keyword bank for a draft is the normal
 * case, since generation is what moves it towards review.
 */
function resolveAssessment(assessmentId) {
  if (!assessmentId || typeof assessmentId !== "string") {
    const err = new Error("assessment_id is required.");
    err.statusCode = 400;
    throw err;
  }

  const entry = AssessmentRegistry.findAssessment(loadRegistry(), assessmentId);
  if (!entry) {
    const err = new Error(
      `No assessment named "${assessmentId}" exists in the registry (data/assessments.json).`
    );
    err.statusCode = 404;
    throw err;
  }
  return entry;
}

/**
 * The repo path of the question bank behind an assessment, or null when the
 * bank lives in Firestore instead ("firestore:<bankId>").
 *
 * Callers that only know how to read a repo path — lib/githubRetriever.js —
 * need the distinction; a null means "not a path I can fetch", not "missing".
 */
function questionBankRepoPath(entry) {
  const ref = entry && entry.assessment && entry.assessment.question_bank_ref;
  if (typeof ref !== "string" || !ref) return null;
  if (ref.startsWith("firestore:")) return null;
  return ref;
}

module.exports = { loadRegistry, resolveAssessment, questionBankRepoPath, REGISTRY_FILE };
