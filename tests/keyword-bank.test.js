/**
 * tests/keyword-bank.test.js
 * ---------------------------------------------------------------------------
 * Tests for §5 and docs/AUDIT.md section H item 4 — the keyword bank's move
 * from a bare unit key to `assessment_id`, the new required/optional concept
 * axis, and the coverage_% the audit found was being computed and discarded.
 *
 * Pure Node — no network, no Firebase, no Gemini. The three pure modules
 * (keywordBankValidator, keywordMatcher, registryStore) are tested directly;
 * lib/keywordBankBuilder.js's Firestore *write* is deliberately not exercised,
 * for the same reason materialStore's isn't: asserting on a mocked write tests
 * the mock.
 *
 * api/grade-open-ended.js IS exercised, against a stubbed Firestore, and that is
 * not the same thing: what is under test there is the handler's own logic — which
 * key wins when both exist, which status code each failure produces, and what
 * does and does not appear in the response body — with the stub standing in only
 * as a data source. The bank-lookup order and the "no rubric in the response"
 * guarantee are both security-relevant enough to pin down permanently.
 *
 * Run it:
 *     cd csa65-quiz-app
 *     node tests/keyword-bank.test.js
 * ---------------------------------------------------------------------------
 */

const assert = require("assert");

const Validator = require("../lib/keywordBankValidator");
const Matcher = require("../lib/keywordMatcher");
const RegistryStore = require("../lib/registryStore");
const { buildKeywordPrompt } = require("../lib/keywordPromptBuilder");

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

/** A raw Gemini-shaped bank for one question id. */
function rawBank(keywords, questionId = "q1") {
  return { entries: { [questionId]: { keywords } } };
}

const IDS = new Set(["q1", "q2"]);

(async () => {

// ---------------------------------------------------------------------------
// Validation — the required/optional axis
// ---------------------------------------------------------------------------

test("an explicit required flag is kept as given", () => {
  const { entries } = Validator.validate(rawBank([
    { term: "tokenization", category: "concept", required: true },
    { term: "subword units", category: "technical-term", required: false },
  ]), IDS);

  const kws = entries.q1.keywords;
  assert.strictEqual(kws.find((k) => k.term === "tokenization").required, true);
  assert.strictEqual(kws.find((k) => k.term === "subword units").required, false);
  assert.strictEqual(entries.q1.requiredCount, 1);
});

test("a missing required flag is derived from the category, not defaulted to true", () => {
  // "mark everything important" is the failure mode being guarded against —
  // only learning-objective implies required.
  const { entries } = Validator.validate(rawBank([
    { term: "self-attention", category: "learning-objective" },
    { term: "query key value", category: "concept" },
    { term: "softmax", category: "technical-term" },
    { term: "scaling factor", category: "incidental" },
  ]), IDS);

  const byTerm = Object.fromEntries(entries.q1.keywords.map((k) => [k.term, k.required]));
  assert.strictEqual(byTerm["self-attention"], true);
  assert.strictEqual(byTerm["query key value"], false);
  assert.strictEqual(byTerm["softmax"], false);
  assert.strictEqual(byTerm["scaling factor"], false);
  assert.strictEqual(entries.q1.requiredCount, 1);
});

test("over-marking required is corrected, keeping the heaviest, and warned about", () => {
  // Four keywords → at most two may be required. All four are flagged; the two
  // lightest must be demoted rather than the entry being dropped.
  const { entries, warnings } = Validator.validate(rawBank([
    { term: "transformer", category: "learning-objective", required: true },
    { term: "encoder", category: "concept", required: true },
    { term: "positional encoding", category: "technical-term", required: true },
    { term: "residual", category: "incidental", required: true },
  ]), IDS);

  assert.strictEqual(entries.q1.requiredCount, 2);
  const stillRequired = entries.q1.keywords.filter((k) => k.required).map((k) => k.term).sort();
  assert.deepStrictEqual(stillRequired, ["encoder", "transformer"]);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].questionId, "q1");
  assert.ok(/demoted to optional/.test(warnings[0].warning));
});

test("the required cap never demotes the last required keyword", () => {
  // A 2-keyword entry: floor(2 * 0.5) = 1, so one survives. A cap that rounded
  // to zero would make full marks unreachable on that entry.
  const { entries } = Validator.validate(rawBank([
    { term: "embedding", category: "learning-objective", required: true },
    { term: "vector", category: "incidental", required: true },
  ]), IDS);
  assert.strictEqual(entries.q1.requiredCount, 1);
});

test("a non-boolean required value is treated as absent, not as truthy", () => {
  const { entries } = Validator.validate(rawBank([
    { term: "attention", category: "concept", required: "yes" },
  ]), IDS);
  assert.strictEqual(entries.q1.keywords[0].required, false);
});

test("entries for a question id that does not exist are still dropped", () => {
  const { entries, dropped } = Validator.validate(
    rawBank([{ term: "x", category: "concept" }], "q-invented"), IDS);
  assert.deepStrictEqual(Object.keys(entries), []);
  assert.strictEqual(dropped.length, 1);
  assert.ok(/does not exist/.test(dropped[0].reasons[0]));
});

test("validate() still returns the pre-existing weighting fields unchanged", () => {
  // Guards against the required/optional work disturbing the scoring maths
  // that already shipped: 4 keywords → ceil(4 * 0.6) = 3 for full marks.
  const { entries } = Validator.validate(rawBank([
    { term: "a", category: "learning-objective" },
    { term: "b", category: "concept" },
    { term: "c", category: "technical-term" },
    { term: "d", category: "incidental" },
  ]), IDS);
  assert.strictEqual(entries.q1.totalWeight, 4 + 3 + 2 + 1);
  assert.strictEqual(entries.q1.minKeywordsForFullMarks, 3);
  assert.strictEqual(entries.q1.targetWeightForFullMarks, 4 + 3 + 2);
});

// ---------------------------------------------------------------------------
// Matching — required minimums and coverage_%
// ---------------------------------------------------------------------------

function bankEntry(keywords) {
  const { entries } = Validator.validate(rawBank(keywords), IDS);
  return entries.q1;
}

test("a missing required concept caps the mark, whatever else is mentioned", () => {
  // The exact gap the audit named: a weight-4 concept skipped while every other
  // term is present used to still reach full marks because the others
  // compensated past targetWeightForFullMarks.
  const entry = bankEntry([
    { term: "self-attention", category: "learning-objective", required: true },
    { term: "query key value", category: "concept" },
    { term: "softmax", category: "technical-term" },
    { term: "scaling factor", category: "incidental" },
  ]);

  const everythingElse = "It uses query key value projections, a softmax, and a scaling factor.";
  const scored = Matcher.scoreAgainstKeywordBank(everythingElse, entry, 10);

  assert.ok(scored.earned < 10, `missing a required concept must not score full marks (got ${scored.earned})`);
  assert.strictEqual(scored.earned, 0, "one required concept, none matched → cap of 0");
  assert.deepStrictEqual(scored.keywordsMissingRequired, ["self-attention"]);
  assert.strictEqual(scored.requiredCoveragePercent, 0);
});

test("the cap is the fraction of required concepts present, not all-or-nothing", () => {
  const entry = bankEntry([
    { term: "encoder", category: "learning-objective", required: true },
    { term: "decoder", category: "concept", required: true },
    { term: "attention", category: "technical-term" },
    { term: "feedforward", category: "incidental" },
  ]);

  const half = Matcher.scoreAgainstKeywordBank(
    "The encoder stack uses attention and a feedforward block.", entry, 10);

  // 1 of 2 required present → cap 0.5 → at most half marks.
  assert.strictEqual(half.requiredCoveragePercent, 50);
  assert.ok(half.earned <= 5, `cap of 0.5 must hold (got ${half.earned})`);
  assert.deepStrictEqual(half.keywordsMissingRequired, ["decoder"]);
});

test("naming every required concept leaves the weighted score in charge", () => {
  const entry = bankEntry([
    { term: "encoder", category: "learning-objective", required: true },
    { term: "decoder", category: "concept", required: true },
    { term: "attention", category: "technical-term" },
    { term: "feedforward", category: "incidental" },
  ]);

  const full = Matcher.scoreAgainstKeywordBank(
    "The encoder and decoder both use attention and a feedforward block.", entry, 10);

  assert.strictEqual(full.requiredCoveragePercent, 100);
  assert.strictEqual(full.earned, 10);
  assert.deepStrictEqual(full.keywordsMissingRequired, []);
});

test("REGRESSION: a legacy bank with no required flags scores exactly as before", () => {
  // Banks already written to Firestore have no `required` field anywhere.
  // Inferring requiredness from the category at grading time would silently
  // re-mark them, so the matcher must honour only an explicit true.
  const legacyEntry = {
    keywords: [
      { term: "self-attention", category: "learning-objective", weight: 4, synonyms: [] },
      { term: "query key value", category: "concept", weight: 3, synonyms: [] },
      { term: "softmax", category: "technical-term", weight: 2, synonyms: [] },
      { term: "scaling factor", category: "incidental", weight: 1, synonyms: [] },
    ],
    totalWeight: 10,
    targetWeightForFullMarks: 9,
  };

  const scored = Matcher.scoreAgainstKeywordBank(
    "It uses query key value projections, a softmax, and a scaling factor.", legacyEntry, 10);

  // 3 + 2 + 1 = 6 of a target of 9 → 0.666… → 6.67, uncapped.
  assert.strictEqual(scored.earned, 6.67);
  assert.strictEqual(scored.requiredCoveragePercent, null, "a legacy bank declares no required concepts");
  assert.deepStrictEqual(scored.keywordsMissingRequired, []);
});

test("coverage_% is reported against TOTAL weight, not the full-marks target", () => {
  const entry = bankEntry([
    { term: "a", category: "learning-objective", required: false },
    { term: "b", category: "concept", required: false },
    { term: "c", category: "technical-term", required: false },
    { term: "d", category: "incidental", required: false },
  ]);
  // Matching a (4) + b (3) of a total of 10 → 70%; the full-marks target is 9,
  // so the mark is 7/9 of 10 — the two numbers answer different questions and
  // must not be conflated.
  const scored = Matcher.scoreAgainstKeywordBank("a and b", entry, 10);
  assert.strictEqual(scored.coveragePercent, 70);
  assert.strictEqual(scored.earned, 7.78);
});

test("coverage_% is 0 for an empty answer and 100 when every concept is named", () => {
  const entry = bankEntry([
    { term: "alpha", category: "concept", required: false },
    { term: "beta", category: "incidental", required: false },
  ]);
  assert.strictEqual(Matcher.scoreAgainstKeywordBank("", entry, 5).coveragePercent, 0);
  assert.strictEqual(Matcher.scoreAgainstKeywordBank("alpha beta", entry, 5).coveragePercent, 100);
});

test("a required concept still matches through its synonyms", () => {
  // A required concept the student phrased differently must not be scored as
  // absent — that is what makes the cap safe to apply at all.
  const entry = bankEntry([
    { term: "large language model", category: "learning-objective", required: true, synonyms: ["LLM", "large language models"] },
    { term: "pretraining", category: "concept" },
  ]);
  const scored = Matcher.scoreAgainstKeywordBank("An LLM is built by pretraining on a large corpus.", entry, 10);
  assert.strictEqual(scored.requiredCoveragePercent, 100);
  assert.deepStrictEqual(scored.keywordsMissingRequired, []);
});

test("word-boundary matching is unchanged — 'class' does not match inside 'classify'", () => {
  const entry = bankEntry([{ term: "class", category: "concept", required: false }]);
  assert.strictEqual(Matcher.scoreAgainstKeywordBank("we classify the input", entry, 5).coveragePercent, 0);
  assert.strictEqual(Matcher.scoreAgainstKeywordBank("the class of the input", entry, 5).coveragePercent, 100);
});

test("feedback names the required gap, and leads with it", () => {
  const entry = bankEntry([
    { term: "self-attention", category: "learning-objective", required: true },
    { term: "softmax", category: "technical-term" },
  ]);
  const scored = Matcher.scoreAgainstKeywordBank("It applies a softmax.", entry, 10);
  assert.ok(/self-attention/.test(scored.feedback), "the required term must be named in the feedback");
  assert.ok(/full marks need/.test(scored.feedback));
  assert.ok(/self-attention/.test(scored.suggestedImprovement),
    "the suggestion must steer at the required gap, not an optional one");
});

test("the result keeps every field the client already consumes", () => {
  // js/quiz-engine.js merges this object over Scorer's, and js/pdf-report.js
  // and the dashboard read these by name — the new coverage fields are
  // additive and must not have displaced any of them.
  const entry = bankEntry([{ term: "alpha", category: "concept" }]);
  const scored = Matcher.scoreAgainstKeywordBank("alpha", entry, 5);
  ["earned", "max", "correct", "needsReview", "keywordsFound", "keywordsMissing", "feedback", "suggestedImprovement"]
    .forEach((field) => assert.ok(field in scored, `missing pre-existing field "${field}"`));
  assert.strictEqual(scored.max, 5);
  assert.strictEqual(scored.correct, null);
  assert.strictEqual(scored.needsReview, true);
});

// ---------------------------------------------------------------------------
// Server-side registry resolution — what makes the assessment_id key usable
// ---------------------------------------------------------------------------

test("resolveAssessment finds the seeded assessment with its subject/unit context", () => {
  const entry = RegistryStore.resolveAssessment("csa65-u1-quiz1");
  assert.strictEqual(entry.assessment.assessment_id, "csa65-u1-quiz1");
  assert.strictEqual(entry.subject.subject_id, "csa65");
  assert.strictEqual(entry.unit.unit_id, "csa65-u1");
  // The legacy roman numeral is what every question in the committed bank
  // carries, so the builder still needs it to reach the right questions.
  assert.strictEqual(entry.unit.legacy_unit_key, "I");
});

test("an unknown assessment id throws a 404, rather than returning null", () => {
  assert.throws(() => RegistryStore.resolveAssessment("no-such-assessment"), (e) => {
    assert.strictEqual(e.statusCode, 404);
    return true;
  });
});

test("a missing assessment_id is a 400, distinguishable from a wrong one", () => {
  assert.throws(() => RegistryStore.resolveAssessment(""), (e) => e.statusCode === 400);
  assert.throws(() => RegistryStore.resolveAssessment(null), (e) => e.statusCode === 400);
});

test("questionBankRepoPath returns a repo path, and null for a Firestore ref", () => {
  const entry = RegistryStore.resolveAssessment("csa65-u1-quiz1");
  assert.strictEqual(RegistryStore.questionBankRepoPath(entry), "data/questions-unit1.json");

  const firestoreBacked = { assessment: { question_bank_ref: "firestore:bank-x" } };
  assert.strictEqual(RegistryStore.questionBankRepoPath(firestoreBacked), null,
    "a Firestore ref is not a path githubRetriever can fetch");
  assert.strictEqual(RegistryStore.questionBankRepoPath({ assessment: {} }), null);
});

test("the registry is cached, so a warm serverless instance re-reads nothing", () => {
  assert.strictEqual(RegistryStore.loadRegistry(), RegistryStore.loadRegistry());
  assert.notStrictEqual(RegistryStore.loadRegistry(), RegistryStore.loadRegistry({ force: true }));
});

// ---------------------------------------------------------------------------
// The prompt — what the model is actually asked for
// ---------------------------------------------------------------------------

test("the prompt asks for required flags and bounds how many may be set", () => {
  const prompt = buildKeywordPrompt({
    syllabusText: "Tokenization splits text into subword units.",
    unit: "I",
    unitTitle: "Fundamentals",
    subjectName: "Generative AI and LLMs",
    assessmentTitle: "Unit I Quiz 1",
    questions: [{ id: "q1", topic: "Tokenization", question: "Explain tokenization." }],
  });

  assert.ok(/"required": true \| false/.test(prompt), "the schema must show the required field");
  assert.ok(/at most 1-2 keywords per question as required/.test(prompt),
    "the prompt must bound requiredness, or the model marks everything required");
  // Subject and assessment are in the prompt because "Unit I" alone does not
  // identify a course — the collision this whole change is about.
  assert.ok(prompt.includes("Generative AI and LLMs"));
  assert.ok(prompt.includes("Unit I Quiz 1"));
  assert.ok(prompt.includes("Explain tokenization."));
});

test("the prompt still works with only a unit, for the legacy flow", () => {
  const prompt = buildKeywordPrompt({
    syllabusText: "text",
    unit: "I",
    unitTitle: "Fundamentals",
    questions: [{ id: "q1", topic: "T", question: "Q?" }],
  });
  assert.ok(prompt.includes("Unit I (Fundamentals)"));
  assert.ok(!/undefined/.test(prompt), "absent subject/assessment must not leak as 'undefined'");
});

// ---------------------------------------------------------------------------
// api/grade-open-ended.js — bank lookup order, and what leaves the function
// ---------------------------------------------------------------------------

/**
 * Loads the handler with lib/firebaseAdmin stubbed out, so no credentials are
 * needed and the two bank keys can be controlled exactly. Nothing else is
 * replaced: the handler's validation, lookup order and response shaping all run
 * for real.
 */
function loadHandlerWithBanks(docs) {
  const Module = require("module");
  const stubDb = {
    collection: () => ({
      doc: (id) => ({ get: async () => ({ exists: id in docs, data: () => docs[id] }) }),
    }),
  };

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request.endsWith("firebaseAdmin")) return { getFirestore: () => stubDb };
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const resolved = require.resolve("../api/grade-open-ended.js");
    delete require.cache[resolved];
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

function fakeRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

const ASSESSMENT_BANK = {
  entries: {
    q1: {
      keywords: [{ term: "alpha", category: "concept", weight: 3, required: true, synonyms: [] }],
      totalWeight: 3, targetWeightForFullMarks: 3, requiredCount: 1,
    },
  },
};
const LEGACY_UNIT_BANK = {
  entries: {
    q1: {
      keywords: [{ term: "legacy-only", category: "concept", weight: 3, synonyms: [] }],
      totalWeight: 3, targetWeightForFullMarks: 3,
    },
  },
};
const ITEMS = [{ questionId: "q1", answerText: "alpha is present", marks: 10 }];

async function grade(docs, body) {
  const handler = loadHandlerWithBanks(docs);
  const res = fakeRes();
  await handler({ method: "POST", body }, res);
  return res;
}

await testAsync("the assessment key is preferred over the legacy unit key", async () => {
  // Both exist. Grading against the unit bank here would mark a correct answer
  // wrong, which is the collision this re-keying exists to prevent.
  const res = await grade(
    { "csa65-u1-quiz1": ASSESSMENT_BANK, I: LEGACY_UNIT_BANK },
    { assessment_id: "csa65-u1-quiz1", unit: "I", items: ITEMS });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.bankKeyedBy, "assessment_id");
  assert.strictEqual(res.body.results[0].earned, 10);
});

await testAsync("falls back to the legacy unit bank when the assessment has none", async () => {
  const res = await grade(
    { I: LEGACY_UNIT_BANK },
    { assessment_id: "csa65-u2-quiz1", unit: "I", items: ITEMS });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.bankKeyedBy, "unit");
  assert.strictEqual(res.body.results[0].found, true);
});

await testAsync("a caller sending only unit still grades, unchanged", async () => {
  const res = await grade({ I: LEGACY_UNIT_BANK }, { unit: "I", items: ITEMS });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.bankKeyedBy, "unit");
});

await testAsync("neither identifier is a 400; no bank under either key is a 404", async () => {
  const missingId = await grade({}, { items: ITEMS });
  assert.strictEqual(missingId.code, 400);

  const noBank = await grade({}, { assessment_id: "csa65-u1-quiz1", unit: "I", items: ITEMS });
  assert.strictEqual(noBank.code, 404);
});

await testAsync("the weighted rubric never leaves the function", async () => {
  // The whole reason grading is server-side: a student can read this response.
  // Weights, synonyms, categories and required flags are precisely gameable, so
  // only computed scores and term names may appear.
  const res = await grade(
    { "csa65-u1-quiz1": ASSESSMENT_BANK },
    { assessment_id: "csa65-u1-quiz1", items: ITEMS });
  const serialized = JSON.stringify(res.body);
  ["weight", "synonyms", "category", "required", "totalWeight", "targetWeightForFullMarks"]
    .forEach((field) => assert.ok(!serialized.includes(`"${field}"`),
      `"${field}" must not appear in a student-visible response`));
  assert.ok(serialized.includes("coveragePercent"), "the coverage fields should reach the client");
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.ok ? "" : `\n          ${r.error}`}`));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

})();
