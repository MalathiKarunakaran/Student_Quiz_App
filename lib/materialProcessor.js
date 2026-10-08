// MaterialProcessor — turns extracted material text into the structured
// "assessment knowledge object" required by §3: topics, learning outcomes,
// course outcomes, important concepts, keywords, technical terms, definitions
// and expected answer concepts.
//
// This is the piece that makes uploaded material REUSABLE rather than
// single-use. Before this module, lib/keywordBankBuilder.js extracted a
// syllabus's text, hashed it, prompted Gemini, and threw the text away — so
// every later use (question generation, a second keyword bank, a different
// assessment on the same unit) re-uploaded and re-paid for the same file.
// Here the derived knowledge is computed once and stored against the material.
//
// Prompt construction and validation live together in this file on purpose:
// unlike question generation — where lib/promptBuilder.js is reused by nobody
// and lib/questionValidator.js is reused by the browser — both halves here
// have exactly one caller (api/process-material.js) and are meaningless apart.
// Splitting them would be ceremony, not separation.

const { callGemini } = require("./llmService");

// Caps, applied after generation. Gemini overshoots list lengths routinely,
// and an unbounded list bloats the Firestore document and the prompts that
// later embed it.
const LIMITS = {
  topics: 30,
  learning_outcomes: 15,
  course_outcomes: 10,
  important_concepts: 40,
  keywords: 60,
  technical_terms: 60,
  definitions: 40,
  expected_answer_concepts: 40,
};

// Gemini's context is large but not free, and a 300-page PDF is usually a
// whole course rather than one unit. Truncation is reported in the result so
// the teacher sees it happened rather than silently getting partial metadata.
const MAX_PROMPT_CHARS = 120000;

const SCHEMA_INSTRUCTIONS = `
Return a single JSON object (not an array) shaped exactly like this:
{
  "subject": "the subject/course this material belongs to, as named in the material (empty string if not stated)",
  "unit": "the unit/module/chapter this material covers, as named in the material (empty string if not stated)",
  "topics": ["distinct teachable topics covered, in the order the material presents them"],
  "learning_outcomes": ["what a student should be able to DO after studying this, each starting with a verb"],
  "course_outcomes": [{ "code": "CO1", "description": "..." }],
  "important_concepts": [{ "concept": "...", "importance": "high" | "medium" | "low", "topic": "the topic above it belongs to" }],
  "keywords": ["single words or short phrases central to this material"],
  "technical_terms": ["domain-specific jargon a student is expected to use correctly"],
  "definitions": [{ "term": "...", "definition": "a one-sentence definition grounded in this material" }],
  "expected_answer_concepts": [{ "topic": "...", "concepts": ["ideas a strong free-text answer on this topic must mention"] }]
}

Rules:
- Ground EVERYTHING strictly in the supplied material. Do not add topics, outcomes, concepts or
  definitions the material does not actually cover, even if they are standard for the subject.
- If the material does not state course outcomes explicitly, return an empty array for
  "course_outcomes" rather than inventing codes.
- "importance" reflects how central a concept is to this material: "high" for ideas the material
  builds on repeatedly, "low" for passing mentions.
- "expected_answer_concepts" is a grading aid: for each major topic, list what a good descriptive
  answer would need to mention. These feed the keyword-based evaluator, so prefer precise,
  checkable concepts over vague ones.
- Use the material's own terminology and spelling.
- Return ONLY the JSON object, no commentary, no markdown code fences.
`.trim();

function buildMetadataPrompt({ materialText, filename, subjectHint, unitHint, truncated }) {
  const hints = [
    subjectHint ? `The teacher has filed this material under the subject: "${subjectHint}".` : "",
    unitHint ? `The teacher has filed it under the unit: "${unitHint}".` : "",
    // Without this, a hint biases the model into reporting the hint back
    // regardless of what the file actually contains, which defeats the point
    // of extracting metadata at all.
    (subjectHint || unitHint)
      ? `Treat these as context only — report what the material ACTUALLY covers, even if it differs.`
      : "",
  ].filter(Boolean).join(" ");

  return `
You are an experienced university professor analysing course material in order to build an
assessment from it. Extract a structured summary of what this material teaches.

${hints}

=== MATERIAL: ${filename} ===
${materialText}
=== END MATERIAL ===
${truncated ? "\n(NOTE: the material was truncated for length — analyse what is present above.)\n" : ""}
${SCHEMA_INSTRUCTIONS}
`.trim();
}

// ---------------------------------------------------------------------------
// Validation — same posture as lib/questionValidator.js and
// lib/keywordBankValidator.js: malformed values are DROPPED, never coerced
// into something plausible-looking.
// ---------------------------------------------------------------------------

const IMPORTANCE_LEVELS = ["high", "medium", "low"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function cleanStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) continue;
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanObjectArray(value, limit, mapFn) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const mapped = mapFn(item);
    if (mapped) out.push(mapped);
    if (out.length >= limit) break;
  }
  return out;
}

function validateMetadata(raw) {
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("Gemini did not return a metadata object.");
    err.statusCode = 502;
    throw err;
  }

  const metadata = {
    subject: isNonEmptyString(raw.subject) ? raw.subject.trim() : "",
    unit: isNonEmptyString(raw.unit) ? raw.unit.trim() : "",
    topics: cleanStringArray(raw.topics, LIMITS.topics),
    learning_outcomes: cleanStringArray(raw.learning_outcomes, LIMITS.learning_outcomes),
    course_outcomes: cleanObjectArray(raw.course_outcomes, LIMITS.course_outcomes, (co) =>
      isNonEmptyString(co.description)
        ? { code: isNonEmptyString(co.code) ? co.code.trim() : "", description: co.description.trim() }
        : null
    ),
    important_concepts: cleanObjectArray(raw.important_concepts, LIMITS.important_concepts, (c) =>
      isNonEmptyString(c.concept)
        ? {
            concept: c.concept.trim(),
            importance: IMPORTANCE_LEVELS.includes(c.importance) ? c.importance : "medium",
            topic: isNonEmptyString(c.topic) ? c.topic.trim() : "",
          }
        : null
    ),
    keywords: cleanStringArray(raw.keywords, LIMITS.keywords),
    technical_terms: cleanStringArray(raw.technical_terms, LIMITS.technical_terms),
    definitions: cleanObjectArray(raw.definitions, LIMITS.definitions, (d) =>
      isNonEmptyString(d.term) && isNonEmptyString(d.definition)
        ? { term: d.term.trim(), definition: d.definition.trim() }
        : null
    ),
    expected_answer_concepts: cleanObjectArray(raw.expected_answer_concepts, LIMITS.expected_answer_concepts, (e) => {
      const concepts = cleanStringArray(e.concepts, 20);
      return isNonEmptyString(e.topic) && concepts.length ? { topic: e.topic.trim(), concepts } : null;
    }),
  };

  // Surfaced to the teacher on the review screen rather than thrown: partial
  // metadata is still worth reviewing and editing, and §3 puts a human between
  // processing and publishing precisely so this is catchable.
  if (metadata.topics.length === 0) warnings.push("No topics were extracted — the material may be too short, or not course material.");
  if (metadata.important_concepts.length === 0) warnings.push("No important concepts were extracted.");
  if (metadata.expected_answer_concepts.length === 0) {
    warnings.push("No expected-answer concepts were extracted — descriptive-answer grading for this material will fall back to per-question keywords.");
  }
  if (metadata.course_outcomes.length === 0) {
    warnings.push("No course outcomes were found in the material — add them manually on the review screen if your department requires CO mapping.");
  }

  return { metadata, warnings };
}

async function parseMetadataObject(prompt, config) {
  let lastError;
  let currentPrompt = prompt;

  for (let attempt = 0; attempt <= config.llmMaxRetries; attempt++) {
    try {
      const text = await callGemini(currentPrompt, config);
      const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("response was not a JSON object");
      }
      return parsed;
    } catch (err) {
      lastError = err;
      currentPrompt = `${prompt}\n\nYour previous response was rejected: ${err.message}\nReturn ONLY a single valid JSON object this time, with no commentary and no markdown code fences.`;
    }
  }
  const err = new Error(`Gemini did not return a valid metadata object after ${config.llmMaxRetries + 1} attempts: ${lastError.message}`);
  err.statusCode = 502;
  throw err;
}

/**
 * materialText: the extracted plain text (lib/documentTextExtractor.js).
 * Returns { metadata, warnings, truncated, charsAnalysed, model }.
 */
async function processMaterial({ materialText, filename, subjectHint, unitHint }, config) {
  if (!isNonEmptyString(materialText)) {
    const err = new Error("There is no extracted text to process for this material.");
    err.statusCode = 400;
    throw err;
  }

  const truncated = materialText.length > MAX_PROMPT_CHARS;
  const usableText = truncated ? materialText.slice(0, MAX_PROMPT_CHARS) : materialText;

  const prompt = buildMetadataPrompt({
    materialText: usableText,
    filename: filename || "uploaded material",
    subjectHint,
    unitHint,
    truncated,
  });

  const raw = await parseMetadataObject(prompt, config);
  const { metadata, warnings } = validateMetadata(raw);

  if (truncated) {
    warnings.unshift(
      `Material was truncated to ${MAX_PROMPT_CHARS.toLocaleString()} of ${materialText.length.toLocaleString()} characters for analysis. ` +
      `Split it into per-unit files for complete coverage.`
    );
  }

  return { metadata, warnings, truncated, charsAnalysed: usableText.length, model: config.geminiModel };
}

module.exports = { processMaterial, validateMetadata, buildMetadataPrompt, LIMITS, MAX_PROMPT_CHARS };
