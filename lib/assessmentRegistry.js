// AssessmentRegistry — the single source of truth for the
// Subject → Unit → Topic → Assessment hierarchy.
//
// DUAL-MODE MODULE, for the same reason lib/questionValidator.js is one: this
// schema is read by the serverless functions (Node) and by the teacher/student
// pages (browser), and a second copy would be free to drift. Drift here would
// surface as an assessment that validates in the teacher panel and then fails
// to open for a student.
//   - Node:    require("./assessmentRegistry") from lib/ and api/
//   - Browser: <script src="lib/assessmentRegistry.js"> → global AssessmentRegistry
//
// WHY A REGISTRY AT ALL. Before this module, a quiz was identified by the path
// of its config file (`data/config-unit1-quiz1.json`) and a question was scoped
// by a bare roman-numeral unit ("I"). Neither carries a subject, so two
// subjects that both have a "Unit I" collide — most damagingly in
// keywordBanks/{unit}, where they would share one grading rubric. Every new
// record is therefore keyed by `assessment_id`, which is globally unique.
//
// BACKWARD COMPATIBILITY IS A FEATURE OF THIS FILE, not a shim bolted on
// elsewhere: toQuizConfig() emits exactly the legacy config shape that
// js/quiz-engine.js already consumes, so the entire student pipeline runs
// unchanged against a registry-driven assessment. See docs/AUDIT.md section H.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AssessmentRegistry = api;
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

// draft        — created, nothing processed yet
// processing   — material uploaded, extraction/metadata in flight
// under_review — questions generated, awaiting teacher approval
// published    — visible to students. ONLY this status is student-visible.
// archived     — withdrawn; kept for the submissions that reference it
const STATUSES = ["draft", "processing", "under_review", "published", "archived"];

const ASSESSMENT_TYPES = ["quiz", "assignment", "exam", "practice"];

// auto          — objective + keyword scoring is final
// auto+review   — auto-scored, open-ended answers flagged for teacher review (current behaviour)
// manual        — teacher marks everything
const EVALUATION_MODES = ["auto", "auto+review", "manual"];

const QUESTION_TYPES = [
  "mcq", "truefalse", "multiselect", "fillblank", "descriptive",
  "scenario", "codeoutput", "debugging", "promptengineering",
];
const DIFFICULTIES = ["easy", "medium", "hard"];
const BLOOM_LEVELS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];

// An id must be safe as a Firestore document id, a URL query value and a
// filename fragment all at once — so: lowercase, no slashes, no dots, no spaces.
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidId(v) {
  return typeof v === "string" && ID_PATTERN.test(v);
}

function slugify(text, fallback = "item") {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateAssessment(a, { subjectId, unitId } = {}) {
  const reasons = [];
  if (!a || typeof a !== "object") return ["not an object"];

  if (!isValidId(a.assessment_id)) {
    reasons.push(`assessment_id "${a.assessment_id}" must be lowercase alphanumeric with - or _ (max 64 chars)`);
  }
  if (!isNonEmptyString(a.title)) reasons.push("missing/empty title");
  if (!ASSESSMENT_TYPES.includes(a.type)) reasons.push(`invalid type "${a.type}"`);
  if (!STATUSES.includes(a.status)) reasons.push(`invalid status "${a.status}"`);
  if (!EVALUATION_MODES.includes(a.evaluation_mode)) {
    reasons.push(`invalid evaluation_mode "${a.evaluation_mode}"`);
  }

  if (!Array.isArray(a.topics)) reasons.push("topics must be an array");
  if (!Number.isInteger(a.question_count) || a.question_count <= 0) {
    reasons.push("question_count must be a positive integer");
  }
  if (!Number.isInteger(a.duration_minutes) || a.duration_minutes <= 0) {
    reasons.push("duration_minutes must be a positive integer");
  }
  if (!Number.isInteger(a.max_attempts) || a.max_attempts < 1) {
    reasons.push("max_attempts must be an integer >= 1");
  }

  if (!Array.isArray(a.question_types) || a.question_types.length === 0) {
    reasons.push("question_types must be a non-empty array");
  } else if (a.question_types.some((t) => !QUESTION_TYPES.includes(t))) {
    reasons.push(`question_types contains an unknown type (allowed: ${QUESTION_TYPES.join(", ")})`);
  }

  if (!Array.isArray(a.difficulty) || a.difficulty.length === 0) {
    reasons.push("difficulty must be a non-empty array");
  } else if (a.difficulty.some((d) => !DIFFICULTIES.includes(d))) {
    reasons.push(`difficulty contains an unknown level (allowed: ${DIFFICULTIES.join(", ")})`);
  }

  if (a.bloom_distribution != null) {
    if (typeof a.bloom_distribution !== "object" || Array.isArray(a.bloom_distribution)) {
      reasons.push("bloom_distribution must be an object mapping bloom level to a percentage");
    } else {
      const unknown = Object.keys(a.bloom_distribution).filter((k) => !BLOOM_LEVELS.includes(k));
      if (unknown.length) reasons.push(`bloom_distribution has unknown level(s): ${unknown.join(", ")}`);
    }
  }

  // A published assessment must actually be openable — this is the gate that
  // makes "Upload → Process → Review → Publish" mean something. An assessment
  // with no questions behind it can sit in draft/under_review all it likes,
  // but it must never reach a student.
  if (a.status === "published" && !isNonEmptyString(a.question_bank_ref)) {
    reasons.push("a published assessment needs a question_bank_ref");
  }

  if (subjectId && a.subject_id && a.subject_id !== subjectId) {
    reasons.push(`subject_id "${a.subject_id}" does not match its parent subject "${subjectId}"`);
  }
  if (unitId && a.unit_id && a.unit_id !== unitId) {
    reasons.push(`unit_id "${a.unit_id}" does not match its parent unit "${unitId}"`);
  }

  return reasons;
}

function validateRegistry(reg) {
  const errors = [];
  if (!reg || typeof reg !== "object") return ["registry must be an object"];
  if (!Array.isArray(reg.subjects)) return ["registry.subjects must be an array"];

  const seenAssessmentIds = new Set();
  const seenSubjectIds = new Set();

  reg.subjects.forEach((s, si) => {
    const where = `subjects[${si}]`;
    if (!isValidId(s.subject_id)) errors.push(`${where}: invalid subject_id "${s.subject_id}"`);
    if (!isNonEmptyString(s.name)) errors.push(`${where}: missing/empty name`);
    if (seenSubjectIds.has(s.subject_id)) errors.push(`${where}: duplicate subject_id "${s.subject_id}"`);
    seenSubjectIds.add(s.subject_id);

    if (!Array.isArray(s.units)) {
      errors.push(`${where}: units must be an array`);
      return;
    }

    const seenUnitIds = new Set();
    s.units.forEach((u, ui) => {
      const uWhere = `${where}.units[${ui}]`;
      if (!isValidId(u.unit_id)) errors.push(`${uWhere}: invalid unit_id "${u.unit_id}"`);
      if (!isNonEmptyString(u.name)) errors.push(`${uWhere}: missing/empty name`);
      if (seenUnitIds.has(u.unit_id)) errors.push(`${uWhere}: duplicate unit_id "${u.unit_id}"`);
      seenUnitIds.add(u.unit_id);
      if (u.topics != null && !Array.isArray(u.topics)) errors.push(`${uWhere}: topics must be an array`);

      if (!Array.isArray(u.assessments)) {
        errors.push(`${uWhere}: assessments must be an array`);
        return;
      }

      u.assessments.forEach((a, ai) => {
        const aWhere = `${uWhere}.assessments[${ai}]`;
        const reasons = validateAssessment(a, { subjectId: s.subject_id, unitId: u.unit_id });
        reasons.forEach((r) => errors.push(`${aWhere}: ${r}`));
        // Globally unique, not just unique within the unit: assessment_id is
        // the Firestore document id for submissions and keyword banks, so a
        // collision across subjects would silently merge two assessments.
        if (a && a.assessment_id) {
          if (seenAssessmentIds.has(a.assessment_id)) {
            errors.push(`${aWhere}: duplicate assessment_id "${a.assessment_id}" (must be unique across ALL subjects)`);
          }
          seenAssessmentIds.add(a.assessment_id);
        }
      });
    });
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function listSubjects(reg) {
  return ((reg && reg.subjects) || []).map((s) => ({
    subject_id: s.subject_id,
    name: s.name,
    code: s.code || "",
    unitCount: (s.units || []).length,
  }));
}

function findSubject(reg, subjectId) {
  return ((reg && reg.subjects) || []).find((s) => s.subject_id === subjectId) || null;
}

function listUnits(reg, subjectId) {
  const subject = findSubject(reg, subjectId);
  return subject ? subject.units || [] : [];
}

function findUnit(reg, subjectId, unitId) {
  return listUnits(reg, subjectId).find((u) => u.unit_id === unitId) || null;
}

/** Every assessment in the registry, each with its subject/unit context attached. */
function listAssessments(reg, filters = {}) {
  const out = [];
  ((reg && reg.subjects) || []).forEach((subject) => {
    (subject.units || []).forEach((unit) => {
      (unit.assessments || []).forEach((assessment) => {
        if (filters.subject_id && subject.subject_id !== filters.subject_id) return;
        if (filters.unit_id && unit.unit_id !== filters.unit_id) return;
        if (filters.status && assessment.status !== filters.status) return;
        if (filters.type && assessment.type !== filters.type) return;
        out.push({ subject, unit, assessment });
      });
    });
  });
  return out;
}

/** Returns { subject, unit, assessment } or null. The main entry point for everything else. */
function findAssessment(reg, assessmentId) {
  return listAssessments(reg).find((e) => e.assessment.assessment_id === assessmentId) || null;
}

/**
 * The ONLY list a student may ever be shown. Centralised here rather than
 * filtered at each call site, so a future status can't accidentally leak into
 * the student picker by being forgotten in one of them.
 */
function listPublishedAssessments(reg, filters = {}) {
  return listAssessments(reg, Object.assign({}, filters, { status: "published" }));
}

/** Union of the topics declared on a unit and those used by its assessments. */
function listTopics(reg, subjectId, unitId) {
  const unit = findUnit(reg, subjectId, unitId);
  if (!unit) return [];
  const topics = new Set(unit.topics || []);
  (unit.assessments || []).forEach((a) => (a.topics || []).forEach((t) => t !== "all" && topics.add(t)));
  return [...topics];
}

// ---------------------------------------------------------------------------
// Backward compatibility — the bridge to the existing quiz pipeline
// ---------------------------------------------------------------------------

/**
 * Projects a registry assessment into the LEGACY quiz-config shape that
 * js/quiz-engine.js, js/data-loader.js and js/scorer.js already consume. This
 * is what makes the migration non-breaking: the student pipeline is not
 * rewritten to understand assessments, it keeps consuming configs, and the
 * registry simply becomes a second way to produce one.
 *
 * `filters.unit` is set from the unit's `legacy_unit_key` when present. That
 * field exists purely so an existing committed question bank — whose questions
 * carry `unit: "I"` — still matches an assessment hanging off unit_id
 * "csa65-u1". New units without legacy banks can omit it.
 */
function toQuizConfig(entry) {
  if (!entry || !entry.assessment) throw new Error("toQuizConfig needs a { subject, unit, assessment } entry.");
  const { subject, unit, assessment } = entry;

  return {
    // Legacy identity. quizId keeps its old role as the per-attempt key so
    // existing localStorage progress/timer keys and submission doc ids stay
    // stable for assessments migrated from a config file.
    quizId: assessment.legacy_quiz_id || assessment.assessment_id,
    quizTitle: assessment.title,
    questionBankFile: assessment.question_bank_ref,

    filters: {
      unit: unit.legacy_unit_key || "",
      topics: assessment.topics && assessment.topics.length ? assessment.topics : ["all"],
      difficulty: assessment.difficulty,
      bloomLevels: assessment.bloom_distribution
        ? Object.keys(assessment.bloom_distribution).filter((k) => assessment.bloom_distribution[k] > 0)
        : BLOOM_LEVELS.slice(),
      questionTypes: assessment.question_types,
    },

    numQuestions: assessment.question_count,
    randomizationMode: assessment.randomization_mode || "seeded",
    seedSource: "rollNumber",
    shuffleOptions: assessment.shuffle_options !== false,
    timeLimitMinutes: assessment.duration_minutes,
    showExplanationsAfterSubmit: assessment.show_explanations === true,
    passingPercentage: assessment.passing_percentage != null ? assessment.passing_percentage : 50,
    allowReviewBeforeSubmit: assessment.allow_review !== false,
    autoSubmitOnTimeout: true,
    negativeMarking: assessment.negative_marking || { enabled: false, penaltyFraction: 0.25 },
    violationPolicy: assessment.violation_policy || { mode: "warn", maxViolations: 3 },
    generatePdfReport: assessment.generate_pdf_report !== false,

    // New identity, carried alongside the legacy fields so js/quiz-engine.js
    // can stamp them onto the submission without needing the registry itself.
    assessment_id: assessment.assessment_id,
    subject_id: subject.subject_id,
    subject_name: subject.name,
    unit_id: unit.unit_id,
    unit_name: unit.name,
    unit_title: unit.title || "",
    max_attempts: assessment.max_attempts,
    evaluation_mode: assessment.evaluation_mode,
    material_reference: assessment.material_reference || null,
  };
}

/**
 * The reverse direction: turns a legacy config object into a draft assessment,
 * so an existing `data/config-*.json` can be imported into the registry
 * instead of being retyped. Produced assessments land in "draft" — importing
 * is never the same as publishing.
 */
function fromQuizConfig(config, { subject_id, unit_id, assessment_id } = {}) {
  const filters = config.filters || {};
  const id = assessment_id || slugify(config.quizId, "imported-assessment");
  return {
    assessment_id: id,
    subject_id: subject_id || "",
    unit_id: unit_id || "",
    title: config.quizTitle || "Untitled Assessment",
    type: "quiz",
    topics: (filters.topics || []).filter((t) => t !== "all"),
    question_bank_ref: config.questionBankFile || "",
    material_reference: null,
    duration_minutes: config.timeLimitMinutes || 25,
    question_count: config.numQuestions || 10,
    question_types: filters.questionTypes || QUESTION_TYPES.slice(),
    difficulty: filters.difficulty || DIFFICULTIES.slice(),
    bloom_distribution: (filters.bloomLevels || BLOOM_LEVELS).reduce((acc, level) => {
      acc[level] = Math.round(100 / (filters.bloomLevels || BLOOM_LEVELS).length);
      return acc;
    }, {}),
    evaluation_mode: "auto+review",
    max_attempts: 1,
    status: "draft",
    randomization_mode: config.randomizationMode || "seeded",
    shuffle_options: config.shuffleOptions !== false,
    show_explanations: config.showExplanationsAfterSubmit === true,
    passing_percentage: config.passingPercentage != null ? config.passingPercentage : 50,
    allow_review: config.allowReviewBeforeSubmit !== false,
    negative_marking: config.negativeMarking || { enabled: false, penaltyFraction: 0.25 },
    violation_policy: config.violationPolicy || { mode: "warn", maxViolations: 3 },
    generate_pdf_report: config.generatePdfReport !== false,
    legacy_quiz_id: config.quizId || null,
    legacy_unit_key: filters.unit || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Where a unit's source material comes from, as a resolution ORDER rather than
 * a hardcoded path. Replaces lib/githubRetriever.js's roman-numeral →
 * `docs/syllabus/unit{N}.md` convention, which capped the app at units I-V of
 * a single subject (docs/AUDIT.md section C).
 *
 * Returns the candidate sources, most-specific first. The caller tries each in
 * turn, so an uploaded material always wins over the legacy repo file, and a
 * subject that has never used the repo convention simply has no legacy entry.
 */
function resolveMaterialSources(entry) {
  if (!entry) return [];
  const { unit, assessment } = entry;
  const sources = [];

  if (assessment && assessment.material_reference) {
    sources.push({ kind: "material", material_id: assessment.material_reference });
  }
  if (unit && unit.material_reference) {
    sources.push({ kind: "material", material_id: unit.material_reference });
  }
  if (unit && unit.legacy_syllabus_path) {
    sources.push({ kind: "repo-path", path: unit.legacy_syllabus_path });
  }
  return sources;
}

return {
  // schema constants
  STATUSES, ASSESSMENT_TYPES, EVALUATION_MODES, QUESTION_TYPES, DIFFICULTIES, BLOOM_LEVELS,
  // validation
  validateRegistry, validateAssessment, isValidId, slugify,
  // lookup
  listSubjects, findSubject, listUnits, findUnit, listTopics,
  listAssessments, findAssessment, listPublishedAssessments,
  // compatibility bridges
  toQuizConfig, fromQuizConfig, resolveMaterialSources,
};
});
