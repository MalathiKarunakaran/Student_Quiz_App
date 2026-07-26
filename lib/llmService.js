// LLMService — the only module that talks to the Gemini API. Uses the
// global fetch already available in Vercel's Node runtime, so no SDK
// dependency is required.

function extractText(geminiResponseBody) {
  const candidate = geminiResponseBody?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) {
    const blockReason = geminiResponseBody?.promptFeedback?.blockReason;
    throw new Error(
      blockReason
        ? `Gemini blocked the request (${blockReason}).`
        : "Gemini returned no usable text content."
    );
  }
  return text;
}

function parseQuestionArray(text) {
  // Gemini's JSON mode should return raw JSON, but strip any stray
  // ```json fencing defensively in case a model ignores the mime type.
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.questions)) return parsed.questions;
  throw new Error("Gemini response was valid JSON but not an array of questions.");
}

async function callGemini(prompt, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.7,
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Gemini API error ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const body = await response.json();
  return extractText(body);
}

// Generates a validated array of raw question objects from the LLM,
// retrying with a corrective instruction if the response isn't parseable JSON.
async function generateQuestionArray(prompt, config) {
  let lastError;
  let currentPrompt = prompt;

  for (let attempt = 0; attempt <= config.llmMaxRetries; attempt++) {
    try {
      const text = await callGemini(currentPrompt, config);
      return parseQuestionArray(text);
    } catch (err) {
      lastError = err;
      currentPrompt = `${prompt}\n\nYour previous response was rejected: ${err.message}\nReturn ONLY a valid JSON array this time, with no commentary and no markdown code fences.`;
    }
  }

  throw new Error(`Gemini did not return valid JSON after ${config.llmMaxRetries + 1} attempts: ${lastError.message}`);
}

module.exports = { generateQuestionArray };
