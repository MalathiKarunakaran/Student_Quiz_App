// DuplicateChecker — removes exact and near-duplicate questions from a
// generated set. Pure string/set logic, no dependencies.
//
// DUAL-MODE MODULE, for the same reason as lib/questionValidator.js: one
// definition of "these two questions are the same question", used by both
// callers, so they can never disagree.
//   - Node (server):  require("./duplicateChecker") from lib/hermesAgent.js,
//                     which DROPS near-duplicates from LLM output.
//   - Browser:        <script src="lib/duplicateChecker.js"> in teacher.html,
//                     exposed as the global `DuplicateChecker`, where
//                     js/bank-editor.js only WARNS about them — an instructor
//                     may well want two deliberate variants of a question, so
//                     silently deleting one of them would be wrong.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DuplicateChecker = api;
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const NEAR_DUPLICATE_THRESHOLD = 0.85;

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Returns { unique: [...], duplicatesRemoved: number }.
function dedupe(questions) {
  const seenExact = new Set();
  const keptTokenSets = [];
  const unique = [];
  let duplicatesRemoved = 0;

  for (const q of questions) {
    const normalized = normalize(q.question);

    if (seenExact.has(normalized)) {
      duplicatesRemoved++;
      continue;
    }

    const tokens = tokenSet(q.question);
    const isNearDuplicate = keptTokenSets.some((kept) => jaccardSimilarity(tokens, kept) >= NEAR_DUPLICATE_THRESHOLD);
    if (isNearDuplicate) {
      duplicatesRemoved++;
      continue;
    }

    seenExact.add(normalized);
    keptTokenSets.push(tokens);
    unique.push(q);
  }

  return { unique, duplicatesRemoved };
}

/**
 * Similarity of two question texts, 0..1, on the same Jaccard measure dedupe()
 * uses. Exposed so the editor can surface a near-duplicate as a warning
 * without having to re-derive the measure and risk disagreeing with the
 * server about what counts as a duplicate.
 */
function similarity(textA, textB) {
  const a = normalize(textA);
  const b = normalize(textB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return jaccardSimilarity(tokenSet(textA), tokenSet(textB));
}

return { dedupe, normalize, similarity, NEAR_DUPLICATE_THRESHOLD };
});
