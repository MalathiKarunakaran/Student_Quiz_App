// HermesAgent — orchestrates the full dynamic-question-generation lifecycle:
// retrieve syllabus context, build the prompt, call the LLM, validate,
// dedupe, tally coverage, and assign final ids. Every step is delegated to a
// focused module so this file stays a thin coordinator.

const { getConfig } = require("./config");
const { fetchSyllabusContext } = require("./githubRetriever");
const { buildPrompt } = require("./promptBuilder");
const { generateQuestionArray } = require("./llmService");
const { validate } = require("./questionValidator");
const { dedupe } = require("./duplicateChecker");

const REQUIRED_STRING_ARRAYS = ["topics", "difficulty", "questionTypes"];

function validateRequest(payload, config) {
  const errors = [];

  if (!payload || typeof payload !== "object") {
    return ["Request body must be a JSON object."];
  }
  if (!payload.unit || typeof payload.unit !== "string") {
    errors.push("unit is required (e.g. \"I\").");
  }
  for (const field of REQUIRED_STRING_ARRAYS) {
    if (!Array.isArray(payload[field]) || payload[field].length === 0) {
      errors.push(`${field} must be a non-empty array.`);
    }
  }
  if (!Number.isInteger(payload.numQuestions) || payload.numQuestions <= 0) {
    errors.push("numQuestions must be a positive integer.");
  } else if (payload.numQuestions > config.maxQuestionsPerRequest) {
    errors.push(`numQuestions cannot exceed ${config.maxQuestionsPerRequest}.`);
  }
  if (payload.bloomDistribution && typeof payload.bloomDistribution !== "object") {
    errors.push("bloomDistribution must be an object mapping bloom level to a percentage.");
  }

  return errors;
}

function tallyCoverage(questions) {
  const tally = (field) => questions.reduce((acc, q) => {
    acc[q[field]] = (acc[q[field]] || 0) + 1;
    return acc;
  }, {});

  return {
    byTopic: tally("topic"),
    byBloom: tally("bloom"),
    byDifficulty: tally("difficulty"),
    byType: tally("type"),
  };
}

function assignIds(questions, unit, courseOutcome) {
  return questions.map((q, index) => ({
    id: `u${unit}-ai-${String(index + 1).padStart(3, "0")}`,
    unit,
    co: courseOutcome || q.co || "Untagged",
    ...q,
  }));
}

// payload: { unit, topics, difficulty, bloomDistribution, questionTypes, numQuestions, courseOutcome }
// Returns { questions, meta } — throws on unrecoverable errors (caller maps to an HTTP response).
async function generateQuestions(payload) {
  const config = getConfig();

  const requestErrors = validateRequest(payload, config);
  if (requestErrors.length > 0) {
    const err = new Error(`Invalid request: ${requestErrors.join(" ")}`);
    err.statusCode = 400;
    throw err;
  }

  const syllabusContext = await fetchSyllabusContext(payload.unit, config);

  const prompt = buildPrompt({
    syllabusContext,
    unit: payload.unit,
    unitTitle: payload.unitTitle || "",
    courseOutcome: payload.courseOutcome || "",
    topics: payload.topics,
    difficulty: payload.difficulty,
    bloomDistribution: payload.bloomDistribution || {},
    questionTypes: payload.questionTypes,
    numQuestions: payload.numQuestions,
  });

  const raw = await generateQuestionArray(prompt, config);

  const { valid, invalid } = validate(raw, { requestedTopics: payload.topics });
  const { unique, duplicatesRemoved } = dedupe(valid);
  const finalQuestions = assignIds(unique, payload.unit, payload.courseOutcome);

  return {
    questions: finalQuestions,
    meta: {
      requested: payload.numQuestions,
      generated: finalQuestions.length,
      droppedInvalid: invalid.length,
      droppedInvalidReasons: invalid.map((i) => i.reasons).flat(),
      droppedDuplicate: duplicatesRemoved,
      coverage: tallyCoverage(finalQuestions),
      model: config.geminiModel,
    },
  };
}

module.exports = { generateQuestions, validateRequest };
