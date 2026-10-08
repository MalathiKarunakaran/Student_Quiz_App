// KeywordBankValidator — checks Gemini's generated keyword-bank JSON against
// the documented schema (see docs/README.md "Keyword-Based Evaluation")
// before it's ever written to Firestore. Anything malformed is dropped, not
// silently coerced — same posture as lib/questionValidator.js.

const VALID_CATEGORIES = ["learning-objective", "concept", "technical-term", "incidental"];
const WEIGHT_BY_CATEGORY = { "learning-objective": 4, "concept": 3, "technical-term": 2, "incidental": 1 };

// REQUIRED vs OPTIONAL concepts (docs/AUDIT.md section D, §5).
//
// Weight alone could not express "this must be present": a weight-4
// learning-objective can be skipped entirely and still reach full marks if
// enough weight-1 and weight-2 terms compensate. `required` is the separate
// axis that closes that — lib/keywordMatcher.js caps the achievable score by
// the fraction of required concepts actually mentioned, so optional terms can
// never substitute for a required one.
//
// Gemini may state `required` per keyword; when it doesn't, it is derived from
// the category, since "learning-objective" already means "the single idea the
// question is really testing".
const REQUIRED_BY_DEFAULT = new Set(["learning-objective"]);

// A rubric where everything is required is a rubric no student passes, and
// "mark it all important" is a well-known failure mode of asking an LLM to
// rank. At most this fraction of an entry's keywords may be required; the
// excess is downgraded lowest-weight-first and reported as a warning rather
// than dropping the entry, which would lose a usable rubric over a judgement
// call that is safe to correct.
const MAX_REQUIRED_FRACTION = 0.5;

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
  const required = typeof kw.required === "boolean" ? kw.required : REQUIRED_BY_DEFAULT.has(category);
  return { term: kw.term.trim(), category, weight: WEIGHT_BY_CATEGORY[category], required, synonyms };
}

/**
 * Enforces MAX_REQUIRED_FRACTION in place. Returns a warning string when it had
 * to intervene, null otherwise.
 *
 * Keeps the highest-weight required keywords and demotes the rest, because
 * weight and requiredness are meant to agree: the terms most central to the
 * answer are the ones that should survive as mandatory.
 */
function capRequiredKeywords(keywords) {
  const allowed = Math.max(1, Math.floor(keywords.length * MAX_REQUIRED_FRACTION));
  const required = keywords.filter((k) => k.required);
  if (required.length <= allowed) return null;

  const keep = new Set(
    required
      .slice()
      .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
      .slice(0, allowed)
  );
  const demoted = [];
  required.forEach((k) => {
    if (!keep.has(k)) {
      k.required = false;
      demoted.push(k.term);
    }
  });

  return `marked ${required.length}/${keywords.length} keywords required (limit ${allowed}); demoted to optional: ${demoted.join(", ")}`;
}

// rawBank: the parsed { entries: { [questionId]: { keywords: [...] } } } from Gemini.
// validQuestionIds: Set of questionId values that actually exist in the current
// question bank for this assessment — entries for any other id are dropped (a
// question id Gemini invented can never be looked up at grading time anyway).
// Returns { entries: {...}, dropped: [{questionId, reasons}], warnings: [{questionId, warning}] }.
function validate(rawBank, validQuestionIds) {
  const entries = {};
  const dropped = [];
  const warnings = [];

  const rawEntries = (rawBank && typeof rawBank === "object" && rawBank.entries) || {};

  for (const [questionId, rawEntry] of Object.entries(rawEntries)) {
    const reasons = [];

    if (!validQuestionIds.has(questionId)) {
      reasons.push(`questionId "${questionId}" does not exist in the current question bank for this assessment`);
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

    const capWarning = capRequiredKeywords(keywords);
    if (capWarning) warnings.push({ questionId, warning: capWarning });

    const totalWeight = keywords.reduce((sum, k) => sum + k.weight, 0);
    const sortedWeights = keywords.map((k) => k.weight).sort((a, b) => b - a);
    const minKeywordsForFullMarks = Math.max(1, Math.min(keywords.length, Math.ceil(keywords.length * 0.6)));
    const targetWeightForFullMarks = sortedWeights.slice(0, minKeywordsForFullMarks).reduce((s, w) => s + w, 0);
    const requiredCount = keywords.filter((k) => k.required).length;

    entries[questionId] = {
      keywords,
      totalWeight,
      targetWeightForFullMarks,
      minKeywordsForFullMarks,
      // Stored explicitly so api/grade-open-ended.js and the teacher dashboard
      // can tell a bank generated with required/optional flags apart from one
      // generated before they existed, without walking keywords[].
      requiredCount,
    };
  }

  return { entries, dropped, warnings };
}

module.exports = {
  validate,
  VALID_CATEGORIES,
  WEIGHT_BY_CATEGORY,
  REQUIRED_BY_DEFAULT,
  MAX_REQUIRED_FRACTION,
};
