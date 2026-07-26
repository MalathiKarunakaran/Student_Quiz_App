// KeywordBankValidator — checks Gemini's generated keyword-bank JSON against
// the documented schema (see docs/README.md "Keyword-Based Evaluation")
// before it's ever written to Firestore. Anything malformed is dropped, not
// silently coerced — same posture as lib/questionValidator.js.

const VALID_CATEGORIES = ["learning-objective", "concept", "technical-term", "incidental"];
const WEIGHT_BY_CATEGORY = { "learning-objective": 4, "concept": 3, "technical-term": 2, "incidental": 1 };

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validateKeyword(kw, reasons, index) {
  if (!kw || typeof kw !== "object") {
    reasons.push(`keyword[${index}] is not an object`);
    return null;
  }
  if (!isNonEmptyString(kw.term)) {
    reasons.push(`keyword[${index}] missing/empty "term"`);
    return null;
  }
  const category = VALID_CATEGORIES.includes(kw.category) ? kw.category : "incidental";
  const synonyms = Array.isArray(kw.synonyms) ? kw.synonyms.filter(isNonEmptyString) : [];
  return { term: kw.term.trim(), category, weight: WEIGHT_BY_CATEGORY[category], synonyms };
}

// rawBank: the parsed { entries: { [questionId]: { keywords: [...] } } } from Gemini.
// validQuestionIds: Set of questionId values that actually exist in the current
// question bank for this unit — entries for any other id are dropped (a
// question id Gemini invented can never be looked up at grading time anyway).
// Returns { entries: {...}, dropped: [{questionId, reasons}] }.
function validate(rawBank, validQuestionIds) {
  const entries = {};
  const dropped = [];

  const rawEntries = (rawBank && typeof rawBank === "object" && rawBank.entries) || {};

  for (const [questionId, rawEntry] of Object.entries(rawEntries)) {
    const reasons = [];

    if (!validQuestionIds.has(questionId)) {
      reasons.push(`questionId "${questionId}" does not exist in the current question bank for this unit`);
      dropped.push({ questionId, reasons });
      continue;
    }

    const rawKeywords = Array.isArray(rawEntry?.keywords) ? rawEntry.keywords : [];
    if (rawKeywords.length < 1) {
      reasons.push("no keywords[] provided");
      dropped.push({ questionId, reasons });
      continue;
    }

    const keywords = [];
    rawKeywords.forEach((kw, i) => {
      const cleaned = validateKeyword(kw, reasons, i);
      if (cleaned) keywords.push(cleaned);
    });

    if (keywords.length < 1) {
      dropped.push({ questionId, reasons });
      continue;
    }

    const totalWeight = keywords.reduce((sum, k) => sum + k.weight, 0);
    const sortedWeights = keywords.map((k) => k.weight).sort((a, b) => b - a);
    const minKeywordsForFullMarks = Math.max(1, Math.min(keywords.length, Math.ceil(keywords.length * 0.6)));
    const targetWeightForFullMarks = sortedWeights.slice(0, minKeywordsForFullMarks).reduce((s, w) => s + w, 0);

    entries[questionId] = { keywords, totalWeight, targetWeightForFullMarks, minKeywordsForFullMarks };
  }

  return { entries, dropped };
}

module.exports = { validate, VALID_CATEGORIES, WEIGHT_BY_CATEGORY };
