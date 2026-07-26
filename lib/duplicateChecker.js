// DuplicateChecker — removes exact and near-duplicate questions from a
// generated set. Pure string/set logic, no dependencies.

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

module.exports = { dedupe, normalize };
