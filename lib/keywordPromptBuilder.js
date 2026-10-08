// KeywordPromptBuilder — turns an uploaded syllabus (extracted plain text)
// plus the existing static question bank into the exact prompt sent to Gemini
// to produce a keyword bank. Kept separate from the calling logic the same
// way lib/promptBuilder.js is separate from lib/hermesAgent.js.

const SCHEMA_INSTRUCTIONS = `
Return a single JSON object (not an array) shaped exactly like this:
{
  "entries": {
    "<questionId>": {
      "keywords": [
        { "term": "short key phrase, 1-4 words", "category": "learning-objective" | "concept" | "technical-term" | "incidental",
          "required": true | false,
          "synonyms": ["alternate phrasing or wording a correct answer might use instead, include common morphological variants"] }
      ]
    }
  }
}

Rules:
- Only include an entry for a questionId if it was listed below as needing one.
- Every entry must have 4-8 keywords.
- "category" reflects how central the term is to a correct answer: "learning-objective" for the single
  most important idea the question is really testing, "concept" for supporting ideas, "technical-term"
  for specific vocabulary/jargon a good answer would name, "incidental" for minor supporting details.
  Use "learning-objective" sparingly (usually only 1 per question).
- "required" marks a concept an answer CANNOT omit and still be considered complete. A student who
  misses a required concept cannot reach full marks no matter how many other terms they mention, so
  mark at most 1-2 keywords per question as required — only the ones whose absence genuinely means the
  question was not answered. Everything else is required: false. Do not mark a term required merely
  because it is useful or because it appears in the syllabus.
- "synonyms" should include real alternate phrasings a student might correctly use instead of "term"
  (e.g. abbreviations, alternate spelling/hyphenation, singular/plural, verb-tense variants) — NOT
  unrelated terms. An empty array is fine if there truly are no natural variants. A required concept
  should list its synonyms generously: a correct answer that uses a different wording must still match.
- Ground every keyword strictly in the supplied syllabus content below — do not invent terminology the
  syllabus doesn't cover.
- Do not include "weight", "id", "topic", or "questionText" fields — those are filled in separately.
- Return ONLY the JSON object, no commentary, no markdown code fences.
`.trim();

/**
 * questions: array of { id, topic, question } for every open-ended
 * (descriptive/scenario/promptengineering/debugging-without-acceptableAnswers)
 * question in the current bank for this assessment — see lib/keywordBankBuilder.js.
 *
 * context: how the rubric is described to the model. `subjectName` and
 * `assessmentTitle` are new alongside the unit — two subjects can both have a
 * "Unit I", and the prompt used to say only "Unit I", which gave the model no
 * way to tell which course's terminology it was grading against.
 */
function buildKeywordPrompt({ syllabusText, unit, unitTitle, subjectName, assessmentTitle, questions }) {
  const questionLines = questions
    .map((q) => `  - id: "${q.id}" | topic: "${q.topic}" | question: "${q.question}"`)
    .join("\n");

  const scope = [
    subjectName ? `the subject "${subjectName}"` : null,
    unit ? `Unit ${unit}${unitTitle ? ` (${unitTitle})` : ""}` : unitTitle || null,
    assessmentTitle ? `the assessment "${assessmentTitle}"` : null,
  ].filter(Boolean).join(", ");

  return `
You are an experienced university professor specializing in Generative AI and Large Language Models,
building a grading rubric for ${scope || "this assessment"}.

For each descriptive/free-text question listed below, extract the important keywords, concepts,
technical terms, and learning objectives a strong answer should mention, grounded strictly in the
syllabus content supplied.

=== SYLLABUS CONTENT (the ONLY source material you may draw from) ===
${syllabusText}
=== END SYLLABUS CONTENT ===

Questions needing a keyword entry:
${questionLines}

${SCHEMA_INSTRUCTIONS}
`.trim();
}

module.exports = { buildKeywordPrompt };
