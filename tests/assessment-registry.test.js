/**
 * tests/assessment-registry.test.js
 * ---------------------------------------------------------------------------
 * Tests for lib/assessmentRegistry.js — the Subject → Unit → Topic →
 * Assessment hierarchy (docs/AUDIT.md section H, item 1).
 *
 * Pure Node, no dependencies, no browser — unlike tests/offline-support.test.js
 * this needs neither Playwright nor a server, because everything under test is
 * a pure function over plain objects. Same harness conventions though: run it
 * directly, exit 0 on pass.
 *
 * Run it:
 *     cd csa65-quiz-app
 *     node tests/assessment-registry.test.js
 *
 * The most important test here is the BACKWARD COMPATIBILITY group: it asserts
 * that projecting the seeded registry assessment through toQuizConfig()
 * produces a config byte-equivalent to the data/config-unit1-quiz1.json that
 * already drives the live quiz. That equivalence is the whole migration
 * safety net (requirement §12) — if it breaks, an existing assessment has
 * silently changed behaviour.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const Registry = require("../lib/assessmentRegistry");

const APP_ROOT = path.resolve(__dirname, "..");
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

function readJSON(relPath) {
  return JSON.parse(fs.readFileSync(path.join(APP_ROOT, relPath), "utf8"));
}

const seedRegistry = readJSON("data/assessments.json");
const legacyConfig = readJSON("data/config-unit1-quiz1.json");

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("the shipped data/assessments.json is valid", () => {
  const errors = Registry.validateRegistry(seedRegistry);
  assert.deepStrictEqual(errors, [], `registry errors:\n  ${errors.join("\n  ")}`);
});

test("rejects a duplicate assessment_id across different subjects", () => {
  // The collision this guards against is not hypothetical: assessment_id is
  // the Firestore document id for keyword banks, so two subjects sharing one
  // would share a grading rubric.
  const reg = {
    subjects: [
      { subject_id: "a", name: "A", units: [{ unit_id: "a-u1", name: "U1", assessments: [makeAssessment({ assessment_id: "dup" })] }] },
      { subject_id: "b", name: "B", units: [{ unit_id: "b-u1", name: "U1", assessments: [makeAssessment({ assessment_id: "dup" })] }] },
    ],
  };
  const errors = Registry.validateRegistry(reg);
  assert.ok(errors.some((e) => /duplicate assessment_id "dup"/.test(e)), `expected a duplicate-id error, got: ${errors.join("; ")}`);
});

test("rejects an id that is unsafe as a Firestore doc id / URL value", () => {
  ["Has Spaces", "UPPER", "has/slash", "has.dot", "", "-leading"].forEach((bad) => {
    assert.strictEqual(Registry.isValidId(bad), false, `"${bad}" should be rejected`);
  });
  ["csa65-u1-quiz1", "a", "unit_2_test"].forEach((good) => {
    assert.strictEqual(Registry.isValidId(good), true, `"${good}" should be accepted`);
  });
});

test("a published assessment must have a question bank behind it", () => {
  const reasons = Registry.validateAssessment(makeAssessment({ status: "published", question_bank_ref: "" }));
  assert.ok(reasons.some((r) => /published assessment needs a question_bank_ref/.test(r)), reasons.join("; "));
  // ...but a draft without one is perfectly legal — that is the whole point of
  // the Upload → Process → Review → Publish lifecycle (requirement §3).
  const draftReasons = Registry.validateAssessment(makeAssessment({ status: "draft", question_bank_ref: "" }));
  assert.deepStrictEqual(draftReasons, [], draftReasons.join("; "));
});

test("rejects unknown enum values", () => {
  assert.ok(Registry.validateAssessment(makeAssessment({ status: "live" })).some((r) => /invalid status/.test(r)));
  assert.ok(Registry.validateAssessment(makeAssessment({ type: "homework" })).some((r) => /invalid type/.test(r)));
  assert.ok(Registry.validateAssessment(makeAssessment({ evaluation_mode: "ai" })).some((r) => /invalid evaluation_mode/.test(r)));
  assert.ok(Registry.validateAssessment(makeAssessment({ question_types: ["essay"] })).some((r) => /unknown type/.test(r)));
  assert.ok(Registry.validateAssessment(makeAssessment({ difficulty: ["impossible"] })).some((r) => /unknown level/.test(r)));
});

test("max_attempts must be at least 1", () => {
  assert.ok(Registry.validateAssessment(makeAssessment({ max_attempts: 0 })).some((r) => /max_attempts/.test(r)));
  assert.deepStrictEqual(Registry.validateAssessment(makeAssessment({ max_attempts: 3 })), []);
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

test("finds the seeded assessment by id, with its subject/unit context", () => {
  const entry = Registry.findAssessment(seedRegistry, "csa65-u1-quiz1");
  assert.ok(entry, "csa65-u1-quiz1 should be findable");
  assert.strictEqual(entry.subject.subject_id, "csa65");
  assert.strictEqual(entry.unit.unit_id, "csa65-u1");
  assert.strictEqual(entry.assessment.title, "CSA65 Unit I — Fundamentals of Generative AI and LLMs");
});

test("returns null for an unknown assessment id rather than throwing", () => {
  assert.strictEqual(Registry.findAssessment(seedRegistry, "does-not-exist"), null);
});

test("listPublishedAssessments excludes every non-published status", () => {
  const reg = JSON.parse(JSON.stringify(seedRegistry));
  const unit = reg.subjects[0].units[0];
  unit.assessments.push(makeAssessment({ assessment_id: "draft-one", status: "draft" }));
  unit.assessments.push(makeAssessment({ assessment_id: "review-one", status: "under_review" }));
  unit.assessments.push(makeAssessment({ assessment_id: "archived-one", status: "archived" }));

  const published = Registry.listPublishedAssessments(reg).map((e) => e.assessment.assessment_id);
  assert.deepStrictEqual(published, ["csa65-u1-quiz1"], `students must only ever see published assessments, got: ${published.join(", ")}`);
});

test("listTopics merges unit topics with those used by its assessments", () => {
  const topics = Registry.listTopics(seedRegistry, "csa65", "csa65-u1");
  assert.ok(topics.includes("Tokenization"));
  assert.ok(topics.includes("Embeddings"));
  assert.strictEqual(topics.length, 13);
});

// ---------------------------------------------------------------------------
// Backward compatibility (requirement §12) — the critical group
// ---------------------------------------------------------------------------

test("toQuizConfig reproduces data/config-unit1-quiz1.json exactly", () => {
  const entry = Registry.findAssessment(seedRegistry, "csa65-u1-quiz1");
  const produced = Registry.toQuizConfig(entry);

  // Compare only the legacy keys. toQuizConfig additionally carries the new
  // assessment_id/subject_id/unit_id identity fields, which the legacy file
  // predates and quiz-engine.js ignores when absent.
  const legacyKeys = Object.keys(legacyConfig).filter((k) => !k.startsWith("_"));
  legacyKeys.forEach((key) => {
    assert.deepStrictEqual(
      produced[key],
      legacyConfig[key],
      `config key "${key}" differs:\n  registry: ${JSON.stringify(produced[key])}\n  legacy:   ${JSON.stringify(legacyConfig[key])}`
    );
  });
});

test("toQuizConfig preserves the legacy quizId, so in-flight attempts are not orphaned", () => {
  // quizId is the localStorage progress/timer key AND half the Firestore
  // submission document id. If the registry changed it, a student mid-attempt
  // when this ships would lose their saved answers and their running clock.
  const produced = Registry.toQuizConfig(Registry.findAssessment(seedRegistry, "csa65-u1-quiz1"));
  assert.strictEqual(produced.quizId, "csa65-unit1-quiz1");
  assert.strictEqual(produced.quizId, legacyConfig.quizId);
});

test("toQuizConfig carries the new identity fields alongside the legacy ones", () => {
  const produced = Registry.toQuizConfig(Registry.findAssessment(seedRegistry, "csa65-u1-quiz1"));
  assert.strictEqual(produced.assessment_id, "csa65-u1-quiz1");
  assert.strictEqual(produced.subject_id, "csa65");
  assert.strictEqual(produced.unit_id, "csa65-u1");
  assert.strictEqual(produced.max_attempts, 1);
  assert.strictEqual(produced.evaluation_mode, "auto+review");
});

test("toQuizConfig maps legacy_unit_key into filters.unit so committed banks still match", () => {
  // Questions in data/questions-unit1.json carry unit:"I". Without this
  // mapping, QuizEngine.filterQuestions() would match nothing and the quiz
  // would fail with "No questions match the configured filters".
  const produced = Registry.toQuizConfig(Registry.findAssessment(seedRegistry, "csa65-u1-quiz1"));
  assert.strictEqual(produced.filters.unit, "I");

  const bank = readJSON("data/questions-unit1.json");
  const matching = bank.questions.filter((q) => q.unit === produced.filters.unit);
  assert.ok(matching.length >= produced.numQuestions,
    `bank has ${matching.length} questions for unit "${produced.filters.unit}" but the assessment asks for ${produced.numQuestions}`);
});

test("an empty topics list becomes the legacy ['all'] wildcard", () => {
  const produced = Registry.toQuizConfig(Registry.findAssessment(seedRegistry, "csa65-u1-quiz1"));
  assert.deepStrictEqual(produced.filters.topics, ["all"]);
});

test("fromQuizConfig imports a legacy config as a DRAFT, never as published", () => {
  const imported = Registry.fromQuizConfig(legacyConfig, { subject_id: "csa65", unit_id: "csa65-u1" });
  assert.strictEqual(imported.status, "draft", "importing must never publish — §3 requires an explicit review step");
  assert.strictEqual(imported.legacy_quiz_id, "csa65-unit1-quiz1");
  assert.strictEqual(imported.legacy_unit_key, "I");
  assert.strictEqual(imported.duration_minutes, 25);
  assert.strictEqual(imported.question_count, 15);
  assert.deepStrictEqual(Registry.validateAssessment(imported), []);
});

test("fromQuizConfig → toQuizConfig round-trips the behavioural settings", () => {
  const imported = Registry.fromQuizConfig(legacyConfig, { subject_id: "csa65", unit_id: "csa65-u1" });
  const roundTripped = Registry.toQuizConfig({
    subject: { subject_id: "csa65", name: "Generative AI and Large Language Models" },
    unit: { unit_id: "csa65-u1", name: "Unit I", legacy_unit_key: imported.legacy_unit_key },
    assessment: imported,
  });

  ["quizId", "quizTitle", "questionBankFile", "numQuestions", "timeLimitMinutes",
   "passingPercentage", "randomizationMode", "shuffleOptions", "allowReviewBeforeSubmit",
   "showExplanationsAfterSubmit", "generatePdfReport"].forEach((key) => {
    assert.deepStrictEqual(roundTripped[key], legacyConfig[key], `"${key}" did not survive the round trip`);
  });
  assert.deepStrictEqual(roundTripped.negativeMarking, legacyConfig.negativeMarking);
  assert.deepStrictEqual(roundTripped.violationPolicy, legacyConfig.violationPolicy);
  assert.deepStrictEqual(roundTripped.filters.unit, legacyConfig.filters.unit);
});

// ---------------------------------------------------------------------------
// Material resolution (replaces the githubRetriever path convention)
// ---------------------------------------------------------------------------

test("resolveMaterialSources prefers uploaded material over the legacy repo path", () => {
  const entry = {
    unit: { legacy_syllabus_path: "docs/syllabus/unit1.md", material_reference: "mat-unit" },
    assessment: { material_reference: "mat-assessment" },
  };
  const sources = Registry.resolveMaterialSources(entry);
  assert.deepStrictEqual(sources, [
    { kind: "material", material_id: "mat-assessment" },
    { kind: "material", material_id: "mat-unit" },
    { kind: "repo-path", path: "docs/syllabus/unit1.md" },
  ], "assessment material must win over unit material, which must win over the repo file");
});

test("the seeded unit still resolves to its legacy syllabus path", () => {
  // Nothing has been uploaded yet, so Unit I must keep generating questions
  // from docs/syllabus/unit1.md exactly as it does today.
  const entry = Registry.findAssessment(seedRegistry, "csa65-u1-quiz1");
  assert.deepStrictEqual(Registry.resolveMaterialSources(entry), [
    { kind: "repo-path", path: "docs/syllabus/unit1.md" },
  ]);
});

test("a unit with no material and no legacy path resolves to nothing, rather than guessing", () => {
  // The old githubRetriever would have built `docs/syllabus/unit{N}.md` and
  // then 404'd at fetch time. Returning [] lets the caller say something
  // actionable instead.
  assert.deepStrictEqual(Registry.resolveMaterialSources({ unit: { unit_id: "x" }, assessment: {} }), []);
});

// ---------------------------------------------------------------------------

function makeAssessment(overrides) {
  return Object.assign({
    assessment_id: "test-assessment",
    title: "Test Assessment",
    type: "quiz",
    status: "draft",
    topics: [],
    question_bank_ref: "data/questions-unit1.json",
    duration_minutes: 25,
    question_count: 10,
    question_types: ["mcq"],
    difficulty: ["easy"],
    evaluation_mode: "auto+review",
    max_attempts: 1,
  }, overrides);
}

const failed = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.ok ? "" : `\n          ${r.error}`}`));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
