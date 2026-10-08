// QuestionValidator — checks a question object against the documented
// Section 5.1 schema (docs/README.md) before it's ever shown to a student.
// Anything that fails is reported, never silently coerced.
//
// DUAL-MODE MODULE. This file is loaded two ways and must keep working in
// both, because it is the single source of truth for the question schema.
// A second, browser-only copy would be free to drift from this one, and the
// drift would surface as a question that validates in the editor and then
// breaks in front of a student:
//   - Node (server):  require("./questionValidator") from lib/hermesAgent.js,
//                     validating LLM-generated questions.
//   - Browser:        <script src="lib/questionValidator.js"> in teacher.html,
//                     exposed as the global `QuestionValidator`, validating
//                     what the instructor types into the bank editor
//                     (js/bank-editor.js).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QuestionValidator = api;
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const VALID_TYPES = [
  "mcq", "truefalse", "multiselect", "fillblank", "descriptive",
  "scenario", "codeoutput", "debugging", "promptengineering",
];
const VALID_DIFFICULTIES = ["easy", "medium", "hard"];
const VALID_BLOOMS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];
const OPEN_ENDED_TYPES = ["descriptive", "scenario", "promptengineering"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function validateCommonFields(q, reasons) {
  if (!isNonEmptyString(q.question)) reasons.push("missing/empty question text");
  if (!VALID_TYPES.includes(q.type)) reasons.push(`invalid type "${q.type}"`);
  if (!VALID_DIFFICULTIES.includes(q.difficulty)) reasons.push(`invalid difficulty "${q.difficulty}"`);
  if (!VALID_BLOOMS.includes(q.bloom)) reasons.push(`invalid bloom "${q.bloom}"`);
  if (!isNonEmptyString(q.topic)) reasons.push("missing/empty topic");
  if (typeof q.marks !== "number" || q.marks <= 0) reasons.push("marks must be a positive number");
  if (!isNonEmptyString(q.explanation)) reasons.push("missing/empty explanation");
}

function validateTypeSpecific(q, reasons) {
  switch (q.type) {
    case "mcq": {
      if (!Array.isArray(q.options) || q.options.length < 2) reasons.push("mcq needs options[] with >=2 items");
      if (!Number.isInteger(q.correctAnswer) || q.correctAnswer < 0 || q.correctAnswer >= (q.options || []).length) {
        reasons.push("mcq correctAnswer must be a valid index into options");
      }
      break;
    }
    case "truefalse": {
      if (typeof q.correctAnswer !== "boolean") reasons.push("truefalse correctAnswer must be boolean");
      break;
    }
    case "multiselect": {
      if (!Array.isArray(q.options) || q.options.length < 2) reasons.push("multiselect needs options[] with >=2 items");
      if (!Array.isArray(q.correctAnswers) || q.correctAnswers.length < 1) {
        reasons.push("multiselect needs correctAnswers[] with >=1 item");
      } else if (q.correctAnswers.some((i) => !Number.isInteger(i) || i < 0 || i >= (q.options || []).length)) {
        reasons.push("multiselect correctAnswers must all be valid indices into options");
      }
      break;
    }
    case "fillblank": {
      if (!Array.isArray(q.acceptableAnswers) || q.acceptableAnswers.length < 1) {
        reasons.push("fillblank needs acceptableAnswers[] with >=1 item");
      }
      break;
    }
    case "codeoutput": {
      if (!isNonEmptyString(q.codeSnippet)) reasons.push("codeoutput needs a non-empty codeSnippet");
      if (!Array.isArray(q.acceptableAnswers) || q.acceptableAnswers.length < 1) {
        reasons.push("codeoutput needs acceptableAnswers[] with >=1 item");
      }
      break;
    }
    case "debugging": {
      // codeSnippet is OPTIONAL here, unlike codeoutput. A debugging question
      // may describe the bug in prose ("a student used a linear activation at
      // every layer — identify the bug") rather than show code, and
      // js/question-renderer.js already treats the snippet as optional
      // (`else if (question.codeSnippet)`). Requiring it rejected
      // u1-debugging-001 — a question that renders and scores correctly in the
      // shipped bank — and would have silently dropped the same shape coming
      // back from the LLM.
      const hasClosedForm = Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length > 0;
      const hasOpenForm = Array.isArray(q.keywords) && q.keywords.length > 0 && isNonEmptyString(q.modelAnswer);
      if (!hasClosedForm && !hasOpenForm) {
        reasons.push("debugging needs either acceptableAnswers[] or keywords[]+modelAnswer");
      }
      break;
    }
    default: {
      if (OPEN_ENDED_TYPES.includes(q.type)) {
        if (!Array.isArray(q.keywords) || q.keywords.length < 1) reasons.push(`${q.type} needs keywords[] with >=1 item`);
        if (!isNonEmptyString(q.modelAnswer)) reasons.push(`${q.type} needs a non-empty modelAnswer`);
      }
    }
  }
}

// Validates raw questions against the schema and, optionally, against the
// set of topics/types the teacher actually requested. Returns
// { valid: [...], invalid: [{ question, reasons }] }.
function validate(rawQuestions, { requestedTopics } = {}) {
  const valid = [];
  const invalid = [];

  for (const q of Array.isArray(rawQuestions) ? rawQuestions : []) {
    const reasons = [];
    if (!q || typeof q !== "object") {
      invalid.push({ question: q, reasons: ["not an object"] });
      continue;
    }

    validateCommonFields(q, reasons);
    if (reasons.length === 0) validateTypeSpecific(q, reasons);

    if (requestedTopics && requestedTopics.length > 0 && isNonEmptyString(q.topic) && !requestedTopics.includes(q.topic)) {
      reasons.push(`topic "${q.topic}" was not one of the requested topics`);
    }

    if (reasons.length === 0) {
      valid.push(q);
    } else {
      invalid.push({ question: q, reasons });
    }
  }

  return { valid, invalid };
}

/**
 * Validates ONE question and returns its reasons[] (empty = valid). The editor
 * needs per-question feedback while the instructor types, whereas the server
 * path wants a whole batch partitioned; both go through the same rules here so
 * neither can accept something the other would reject.
 */
function validateOne(q) {
  const reasons = [];
  if (!q || typeof q !== "object") return ["not an object"];
  validateCommonFields(q, reasons);
  if (reasons.length === 0) validateTypeSpecific(q, reasons);
  return reasons;
}

return { validate, validateOne, VALID_TYPES, VALID_DIFFICULTIES, VALID_BLOOMS, OPEN_ENDED_TYPES };
});
