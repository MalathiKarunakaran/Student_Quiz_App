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

const IMPROVEMENT_TEMPLATES = {
  low: (t) => `Revisit the core concept(s) of ${t} — this looks like a central idea the question is testing.`,
  medium: (t) => `You're partly there — strengthen your answer by also explaining ${t}.`,
  high: (t) => `Good coverage — for full marks, briefly add a note on ${t} as well.`,
};

function buildFeedback(matched, missing) {
  const parts = [];
  parts.push(
    matched.length
      ? `Your answer covered: ${matched.slice(0, 5).map((m) => m.term).join(", ")}.`
      : "Your answer did not clearly reference any of the expected key terms."
  );
  if (missing.length) {
    parts.push(`Not clearly mentioned: ${missing.slice(0, 5).map((m) => m.term).join(", ")}.`);
  }
  return parts.join(" ");
}

function buildSuggestion(missing, ratio) {
  if (!missing.length) return "No specific gaps detected — well covered.";
  const bucket = ratio < 0.4 ? "low" : ratio < 0.75 ? "medium" : "high";
  const topTerms = missing.slice(0, 2).map((m) => m.term).join(" and ");
  return IMPROVEMENT_TEMPLATES[bucket](topTerms);
}

/**
 * bankEntry: { keywords: [{term, category, weight, synonyms[]}], totalWeight,
 *              targetWeightForFullMarks }  — see keywordBanks/{unit} schema.
 * Returns the same shape js/scorer.js's scoreOpenEnded() already returns, so
 * api/grade-open-ended.js can hand results straight back to the client.
 */
function scoreAgainstKeywordBank(studentText, bankEntry, questionMarks) {
  const normalized = normalize(studentText);
  const matched = [];
  const missing = [];
  let earnedWeight = 0;

  (bankEntry.keywords || []).forEach((kw) => {
    const weight = weightForKeyword(kw);
    const forms = [kw.term, ...(kw.synonyms || [])];
    const hitForm = forms.find((f) => matchesSurfaceForm(normalized, f));
    if (hitForm) {
      earnedWeight += weight;
      matched.push({ term: kw.term, weight, category: kw.category, matchedVia: hitForm });
    } else {
      missing.push({ term: kw.term, weight, category: kw.category });
    }
  });

  const target = bankEntry.targetWeightForFullMarks || bankEntry.totalWeight || 1;
  const ratio = target > 0 ? Math.min(1, earnedWeight / target) : 0;
  const earned = Math.round(ratio * questionMarks * 100) / 100;

  matched.sort((a, b) => b.weight - a.weight);
  missing.sort((a, b) => b.weight - a.weight);

  return {
    earned,
    max: questionMarks,
    correct: null,
    needsReview: true,
    keywordsFound: matched.map((m) => m.term),
    keywordsMissing: missing.map((m) => m.term),
    feedback: buildFeedback(matched, missing),
    suggestedImprovement: buildSuggestion(missing, ratio),
  };
}

module.exports = { scoreAgainstKeywordBank, WEIGHT_BY_CATEGORY };
