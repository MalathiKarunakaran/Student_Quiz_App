// PromptBuilder — turns a teacher's quiz configuration into the exact prompt
// text sent to the LLM. Kept separate from llmService.js so the prompt can be
// reviewed/tuned without touching any HTTP/parsing logic.

const SCHEMA_INSTRUCTIONS = `
Return a JSON array (not an object) of question objects. Every question object
must include these common fields:
- "topic": string — must be exactly one of the requested topics below.
- "type": string — must be exactly one of the requested question types below.
- "difficulty": one of "easy", "medium", "hard".
- "bloom": one of "remember", "understand", "apply", "analyze", "evaluate", "create".
- "question": string — the question text shown to the student.
- "marks": a positive number.
- "explanation": string — a short explanation shown to the student after they submit.

Then, depending on "type", also include:
- "mcq": "options" (array of exactly 4 plain strings) and "correctAnswer" (integer index into "options").
- "truefalse": "correctAnswer" (boolean true or false).
- "multiselect": "options" (array of 4-6 plain strings) and "correctAnswers" (array of integer indices into "options", at least 2).
- "fillblank": "acceptableAnswers" (array of 1-4 acceptable string answers) and "caseSensitive" (boolean, usually false).
- "codeoutput": "codeSnippet" (a short, self-contained, runnable Python code string using \\n for newlines) and "acceptableAnswers" (array of acceptable output strings).
- "debugging": "codeSnippet" (Python code containing a deliberate bug) and either "acceptableAnswers" (if there's one exact fix/output) or "keywords" + "minKeywordsForFullMarks" + "modelAnswer" (if the fix is better described in prose).
- "descriptive", "scenario", "promptengineering": "keywords" (array of 4-8 important terms/phrases a good answer should mention), "minKeywordsForFullMarks" (integer, usually 3-5), and "modelAnswer" (a 2-4 sentence ideal answer, instructor-facing only, never shown to the student).

Do not include an "id" or "co" field — those are assigned after generation.
Do not wrap the array in any other object or add commentary. Return ONLY the JSON array.
`.trim();

function buildPrompt({
  syllabusContext,
  unit,
  unitTitle,
  courseOutcome,
  topics,
  difficulty,
  bloomDistribution,
  questionTypes,
  numQuestions,
}) {
  const bloomLines = Object.entries(bloomDistribution || {})
    .filter(([, pct]) => pct > 0)
    .map(([level, pct]) => `  - ${level}: ~${pct}%`)
    .join("\n");

  return `
You are an experienced university professor specializing in Generative AI and Large Language Models, writing an assessment for Unit ${unit} (${unitTitle}), Course Outcome ${courseOutcome}.

Generate exactly ${numQuestions} university-level assessment questions strictly from the supplied syllabus content below. Cover the requested topics proportionally. Do not generate anything outside this syllabus content. Avoid duplicate or near-duplicate questions. Follow the requested Bloom's Taxonomy distribution as closely as possible.

=== SYLLABUS CONTENT (the ONLY source material you may draw from) ===
${syllabusContext}
=== END SYLLABUS CONTENT ===

Requested topics (use only these, distribute questions across them):
${(topics || []).map((t) => `  - ${t}`).join("\n")}

Requested difficulty levels (mix across these):
${(difficulty || []).map((d) => `  - ${d}`).join("\n")}

Requested Bloom's Taxonomy distribution (approximate percentages):
${bloomLines || "  - (no preference — use a reasonable spread)"}

Requested question types (mix across these):
${(questionTypes || []).map((t) => `  - ${t}`).join("\n")}

${SCHEMA_INSTRUCTIONS}
`.trim();
}

module.exports = { buildPrompt };
