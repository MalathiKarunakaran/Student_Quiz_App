// Vercel serverless function — POST /api/grade-open-ended
// Called by any student at quiz-submit time — deliberately NO auth check
// (students are never authenticated in this app). Reads the keyword bank via
// firebase-admin (which bypasses the deny-all client security rules — see
// firestore.rules) and scores each submitted open-ended answer with the plain,
// deterministic lib/keywordMatcher.js. Returns ONLY the computed score/feedback
// per question — the weighted keyword list itself never leaves this function.
//
// BANK LOOKUP, in order:
//   1. keywordBanks/{assessment_id}  — the current key (docs/AUDIT.md H item 4)
//   2. keywordBanks/{unit}           — the legacy key, for banks generated
//                                      before the re-keying. Tried only as a
//                                      fallback, so an assessment that has its
//                                      own bank is never graded against a
//                                      unit-wide one it happens to share a
//                                      roman numeral with.
// The fallback is what keeps already-generated banks working without a data
// migration; it can be dropped once every live bank has been regenerated.
//
// On any failure (network unreachable, no bank generated yet, etc.), the
// client (js/open-ended-grader.js) falls back to the existing local
// plain-keyword js/scorer.js scoreOpenEnded() logic, unchanged.

const { getFirestore } = require("../lib/firebaseAdmin");
const { scoreAgainstKeywordBank } = require("../lib/keywordMatcher");

const COLLECTION = "keywordBanks";
const MAX_ITEMS_PER_REQUEST = 50;
const MAX_ANSWER_LENGTH = 20000;

function isValidItem(item) {
  return (
    item &&
    typeof item.questionId === "string" && item.questionId.length > 0 &&
    typeof item.answerText === "string" &&
    typeof item.marks === "number" && item.marks > 0
  );
}

/** Returns { entries, bankId, keyedBy } or null when neither key has a bank. */
async function loadBank(db, assessmentId, unit) {
  const candidates = [];
  if (assessmentId) candidates.push({ id: assessmentId, keyedBy: "assessment_id" });
  if (unit) candidates.push({ id: unit, keyedBy: "unit" });

  for (const candidate of candidates) {
    const doc = await db.collection(COLLECTION).doc(candidate.id).get();
    if (doc.exists) {
      return { entries: doc.data().entries || {}, bankId: candidate.id, keyedBy: candidate.keyedBy };
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const { assessment_id: assessmentId, unit, items } = req.body || {};

  const hasAssessmentId = typeof assessmentId === "string" && assessmentId.length > 0;
  const hasUnit = typeof unit === "string" && unit.length > 0;
  if (!hasAssessmentId && !hasUnit) {
    res.status(400).json({ error: "assessment_id (preferred) or unit is required." });
    return;
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_PER_REQUEST) {
    res.status(400).json({ error: `items must be a non-empty array of at most ${MAX_ITEMS_PER_REQUEST} entries.` });
    return;
  }
  if (items.some((i) => !isValidItem(i) || i.answerText.length > MAX_ANSWER_LENGTH)) {
    res.status(400).json({ error: "Each item needs a questionId (string), answerText (string), and marks (positive number)." });
    return;
  }

  try {
    const db = getFirestore();
    const bank = await loadBank(db, hasAssessmentId ? assessmentId : null, hasUnit ? unit : null);

    if (!bank) {
      const named = hasAssessmentId ? `assessment "${assessmentId}"` : `Unit ${unit}`;
      res.status(404).json({ error: `No keyword bank has been generated yet for ${named}.` });
      return;
    }

    const results = items.map((item) => {
      const bankEntry = bank.entries[item.questionId];
      if (!bankEntry) {
        return { questionId: item.questionId, found: false };
      }
      const scored = scoreAgainstKeywordBank(item.answerText, bankEntry, item.marks);
      return { questionId: item.questionId, found: true, ...scored };
    });

    // bankKeyedBy is diagnostic only — it tells the teacher dashboard whether a
    // submission was graded against the assessment's own bank or an inherited
    // legacy unit bank. It carries no rubric content.
    res.status(200).json({ results, bankKeyedBy: bank.keyedBy });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Grading failed." });
  }
};
