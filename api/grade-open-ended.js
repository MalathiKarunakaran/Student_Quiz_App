// Vercel serverless function — POST /api/grade-open-ended
// Called by any student at quiz-submit time — deliberately NO auth check
// (students are never authenticated in this app). Reads keywordBanks/{unit}
// via firebase-admin (which bypasses the deny-all client security rules — see
// firestore.rules) and scores each submitted open-ended answer with the plain,
// deterministic lib/keywordMatcher.js. Returns ONLY the computed score/feedback
// per question — the weighted keyword list itself never leaves this function.
//
// On any failure (network unreachable, no bank generated yet, etc.), the
// client (js/open-ended-grader.js) falls back to the existing local
// plain-keyword js/scorer.js scoreOpenEnded() logic, unchanged.

const { getFirestore } = require("../lib/firebaseAdmin");
const { scoreAgainstKeywordBank } = require("../lib/keywordMatcher");

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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const { unit, items } = req.body || {};

  if (typeof unit !== "string" || !unit) {
    res.status(400).json({ error: "unit is required." });
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
    const doc = await db.collection("keywordBanks").doc(unit).get();

    if (!doc.exists) {
      res.status(404).json({ error: `No keyword bank has been generated yet for Unit ${unit}.` });
      return;
    }

    const entries = doc.data().entries || {};
    const results = items.map((item) => {
      const bankEntry = entries[item.questionId];
      if (!bankEntry) {
        return { questionId: item.questionId, found: false };
      }
      const scored = scoreAgainstKeywordBank(item.answerText, bankEntry, item.marks);
      return { questionId: item.questionId, found: true, ...scored };
    });

    res.status(200).json({ results });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Grading failed." });
  }
};
