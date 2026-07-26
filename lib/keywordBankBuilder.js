// KeywordBankBuilder — orchestrates the full keyword-bank lifecycle: extract
// syllabus text, hash it, skip Gemini entirely if unchanged, otherwise fetch
// the current question bank, prompt Gemini, validate, and write to Firestore.
// Thin coordinator, same role as lib/hermesAgent.js plays for question
// generation — every step below is delegated to a focused module.

const crypto = require("crypto");
const { getConfig } = require("./config");
const { extractText } = require("./documentTextExtractor");
const { fetchQuestionBank } = require("./githubRetriever");
const { buildKeywordPrompt } = require("./keywordPromptBuilder");
const { callGemini } = require("./llmService");
const { validate } = require("./keywordBankValidator");
const { getFirestore } = require("./firebaseAdmin");
const admin = require("firebase-admin");

const OPEN_ENDED_TYPES = ["descriptive", "scenario", "promptengineering"];

function isOpenEnded(q) {
  if (OPEN_ENDED_TYPES.includes(q.type)) return true;
  // "debugging" is open-ended only when it has no closed-form acceptableAnswers.
  return q.type === "debugging" && !(Array.isArray(q.acceptableAnswers) && q.acceptableAnswers.length > 0);
}

function normalizeSyllabusText(text) {
  return (text || "").trim().replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
}

function hashSyllabusText(text) {
  return crypto.createHash("sha256").update(normalizeSyllabusText(text), "utf8").digest("hex");
}

async function parseKeywordBankObject(prompt, config) {
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
  throw new Error(`Gemini did not return a valid JSON object after ${config.llmMaxRetries + 1} attempts: ${lastError.message}`);
}

// payload: { unit, unitTitle, fileBase64, filename, forceRegenerate }
// teacherEmail: the verified caller, stamped onto the stored bank as generatedBy.
// Returns { skipped, entries, dropped, coverage, model } — throws on unrecoverable errors.
async function buildKeywordBank(payload, teacherEmail) {
  const config = getConfig();
  const db = getFirestore();

  if (!payload || !payload.unit || !payload.fileBase64 || !payload.filename) {
    const err = new Error("unit, fileBase64, and filename are all required.");
    err.statusCode = 400;
    throw err;
  }

  const rawText = await extractText(payload.fileBase64, payload.filename);
  const sourceContentHash = hashSyllabusText(rawText);

  const docRef = db.collection("keywordBanks").doc(payload.unit);
  const existing = await docRef.get();
  if (existing.exists && !payload.forceRegenerate && existing.data().sourceContentHash === sourceContentHash) {
    return {
      skipped: true,
      reason: "Syllabus content is unchanged since the last generation — skipped calling Gemini.",
      entries: existing.data().entries || {},
      generatedAt: existing.data().generatedAt,
    };
  }

  const allQuestions = await fetchQuestionBank(payload.unit, config);
  const openEnded = allQuestions.filter(isOpenEnded);
  if (openEnded.length === 0) {
    const err = new Error(`No descriptive/scenario/prompt-engineering/open-debugging questions found for Unit ${payload.unit} — nothing to generate keywords for.`);
    err.statusCode = 400;
    throw err;
  }

  const prompt = buildKeywordPrompt({
    syllabusText: rawText,
    unit: payload.unit,
    unitTitle: payload.unitTitle || "",
    questions: openEnded.map((q) => ({ id: q.id, topic: q.topic, question: q.question })),
  });

  const rawBank = await parseKeywordBankObject(prompt, config);
  const validQuestionIds = new Set(openEnded.map((q) => q.id));
  const { entries, dropped } = validate(rawBank, validQuestionIds);

  // Merge topic/questionText from the real question bank into each entry —
  // Gemini's response only carries keywords, per the prompt's schema.
  const questionById = new Map(openEnded.map((q) => [q.id, q]));
  for (const [questionId, entry] of Object.entries(entries)) {
    const q = questionById.get(questionId);
    entry.topic = q.topic;
    entry.questionText = q.question;
  }

  await docRef.set({
    unit: payload.unit,
    unitTitle: payload.unitTitle || "",
    sourceContentHash,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    generatedBy: teacherEmail,
    model: config.geminiModel,
    entries,
  });

  return {
    skipped: false,
    entries,
    dropped,
    coverage: { requested: openEnded.length, generated: Object.keys(entries).length, droppedCount: dropped.length },
    model: config.geminiModel,
  };
}

module.exports = { buildKeywordBank, hashSyllabusText, isOpenEnded };
