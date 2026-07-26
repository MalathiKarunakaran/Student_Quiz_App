// Vercel serverless function — POST /api/generate-questions
// Thin HTTP wrapper around HermesAgent; the request/response contract is
// documented in docs/README.md's AI Integration section.

const { generateQuestions } = require("../lib/hermesAgent");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  try {
    const result = await generateQuestions(req.body);
    res.status(200).json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message || "Question generation failed." });
  }
};
