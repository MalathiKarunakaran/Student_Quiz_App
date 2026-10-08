// KeywordMatcher — weighted keyword + synonym scoring for descriptive/scenario/
// prompt-engineering answers. Pure, dependency-free, deterministic (no LLM
// call here — the bank of keywords/synonyms/weights was already generated
// once, teacher-triggered, by lib/keywordBankBuilder.js). Runs server-side
// only (api/grade-open-ended.js) so the weighted "answer key" itself is never
// sent to a student's browser.
//
// This supersedes js/scorer.js's plain substring scoreOpenEnded() ONLY when a
// keyword bank entry exists for a question; scorer.js's original logic
// remains the fallback everywhere else (see js/open-ended-grader.js).

const WEIGHT_BY_CATEGORY = {
  "learning-objective": 4,
  "concept": 3,
  "technical-term": 2,
  "incidental": 1,
};

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match, tolerant of hyphen/space variants between words (so
// "byte-pair encoding", "byte pair encoding", and "byte  pair  encoding" all
// match the same surface form). Deliberately NOT a plain substring test —
// "class" must not match inside "classify".
function matchesSurfaceForm(normalizedText, surfaceForm) {
  const escaped = escapeRegex(surfaceForm.trim().toLowerCase()).replace(/[\s-]+/g, "[\\s-]+");
  if (!escaped) return false;
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return re.test(normalizedText);
}

function weightForKeyword(kw) {
  if (typeof kw.weight === "number" && kw.weight > 0) return kw.weight;
  return WEIGHT_BY_CATEGORY[kw.category] || WEIGHT_BY_CATEGORY["incidental"];
}

// Only an EXPLICIT `required: true` counts.
//
// Deliberately not derived from the category here, even though
// lib/keywordBankValidator.js derives it that way when generating. Banks
// generated before required/optional existed are already in Firestore with no
// `required` field anywhere; inferring it at grading time would silently make
// every one of those banks stricter and move marks on already-graded-style
// answers. A legacy bank therefore has zero required concepts and scores
// exactly as it did before — the stricter rule applies only to banks that were
// generated with it. Regenerating a bank is what opts an assessment in.
function isRequired(kw) {
  return kw.required === true;
}

const IMPROVEMENT_TEMPLATES = {
  low: (t) => `Revisit the core concept(s) of ${t} — this looks like a central idea the question is testing.`,
  medium: (t) => `You're partly there — strengthen your answer by also explaining ${t}.`,
  high: (t) => `Good coverage — for full marks, briefly add a note on ${t} as well.`,
};

function buildFeedback(matched, missing, missingRequired) {
  const parts = [];
  parts.push(
    matched.length
      ? `Your answer covered: ${matched.slice(0, 5).map((m) => m.term).join(", ")}.`
      : "Your answer did not clearly reference any of the expected key terms."
  );
  // Required gaps lead, ahead of the general missing list: they are the ones
  // that actually capped the mark, so naming them first makes the score
  // explicable to the student.
  if (missingRequired.length) {
    parts.push(
      `Expected but not mentioned: ${missingRequired.map((m) => m.term).join(", ")} — ` +
      `full marks need ${missingRequired.length === 1 ? "this concept" : "these concepts"}.`
    );
  }
  const otherMissing = missing.filter((m) => !isRequired(m));
  if (otherMissing.length) {
    parts.push(`Also not clearly mentioned: ${otherMissing.slice(0, 5).map((m) => m.term).join(", ")}.`);
  }
  return parts.join(" ");
}

function buildSuggestion(missing, missingRequired, ratio) {
  if (!missing.length) return "No specific gaps detected — well covered.";
  // Steer the suggestion at required gaps when there are any; those are what
  // the student has to fix to move the mark.
  const focus = missingRequired.length ? missingRequired : missing;
  const bucket = ratio < 0.4 ? "low" : ratio < 0.75 ? "medium" : "high";
  const topTerms = focus.slice(0, 2).map((m) => m.term).join(" and ");
  return IMPROVEMENT_TEMPLATES[bucket](topTerms);
}

function roundTo1dp(n) {
  return Math.round(n * 10) / 10;
}

/**
 * bankEntry: { keywords: [{term, category, weight, required, synonyms[]}],
 *              totalWeight, targetWeightForFullMarks, requiredCount }
 *            — see the keywordBanks/{assessment_id} schema in
 *              lib/keywordBankValidator.js.
 *
 * Returns the shape js/scorer.js's scoreOpenEnded() returns, plus the §5
 * coverage fields (coveragePercent, requiredCoveragePercent, keywordsMissingRequired),
 * so api/grade-open-ended.js can hand results straight back to the client. The
 * extra fields are additive — js/quiz-engine.js merges by Object.assign and the
 * dashboard reads by name, so nothing breaks on a result that lacks them.
 *
 * SCORING, in one sentence: the weighted ratio decides the mark, and the
 * fraction of REQUIRED concepts present caps it. Missing a required concept
 * therefore cannot be compensated for by naming extra optional ones, which is
 * the whole point of the required flag (docs/AUDIT.md section D).
 */
function scoreAgainstKeywordBank(studentText, bankEntry, questionMarks) {
  const normalized = normalize(studentText);
  const matched = [];
  const missing = [];
  let earnedWeight = 0;
  let totalWeight = 0;
  let requiredTotal = 0;
  let requiredMatched = 0;

  (bankEntry.keywords || []).forEach((kw) => {
    const weight = weightForKeyword(kw);
    const required = isRequired(kw);
    totalWeight += weight;
    if (required) requiredTotal++;

    const forms = [kw.term, ...(kw.synonyms || [])];
    const hitForm = forms.find((f) => matchesSurfaceForm(normalized, f));
    if (hitForm) {
      earnedWeight += weight;
      if (required) requiredMatched++;
      matched.push({ term: kw.term, weight, category: kw.category, required, matchedVia: hitForm });
    } else {
      missing.push({ term: kw.term, weight, category: kw.category, required });
    }
  });

  const target = bankEntry.targetWeightForFullMarks || bankEntry.totalWeight || totalWeight || 1;
  const weightedRatio = target > 0 ? Math.min(1, earnedWeight / target) : 0;

  // 1 when the bank declares no required concepts — a legacy bank then scores
  // identically to before this cap existed.
  const requiredCoverage = requiredTotal === 0 ? 1 : requiredMatched / requiredTotal;
  const ratio = Math.min(weightedRatio, requiredCoverage);
  const earned = Math.round(ratio * questionMarks * 100) / 100;

  matched.sort((a, b) => b.weight - a.weight);
  missing.sort((a, b) => b.weight - a.weight);
  const missingRequired = missing.filter(isRequired);

  // coveragePercent is deliberately earned/TOTAL weight, not earned/target:
  // it answers "how much of the rubric did this answer cover", which is a
  // different question from "did it earn full marks". targetWeightForFullMarks
  // is ~60% of total weight, so a full-mark answer can legitimately show a
  // coverage below 100 — that is informative, not a bug.
  const effectiveTotal = bankEntry.totalWeight || totalWeight;
  return {
    earned,
    max: questionMarks,
    correct: null,
    needsReview: true,
    keywordsFound: matched.map((m) => m.term),
    keywordsMissing: missing.map((m) => m.term),
    keywordsMissingRequired: missingRequired.map((m) => m.term),
    coveragePercent: effectiveTotal > 0 ? roundTo1dp((earnedWeight / effectiveTotal) * 100) : 0,
    requiredCoveragePercent: requiredTotal === 0 ? null : roundTo1dp(requiredCoverage * 100),
    feedback: buildFeedback(matched, missing, missingRequired),
    suggestedImprovement: buildSuggestion(missing, missingRequired, ratio),
  };
}

module.exports = { scoreAgainstKeywordBank, WEIGHT_BY_CATEGORY, isRequired };
