// Vercel serverless function — POST /api/generate-keywords
// Teacher-only (verifies a Firebase ID token against TEACHER_EMAILS). Thin
// HTTP wrapper around KeywordBankBuilder, mirroring api/generate-questions.js's
// relationship to lib/hermesAgent.js.

const { verifyTeacherToken } = require("../lib/firebaseAdmin");
const { buildKeywordBank } = require("../lib/keywordBankBuilder");
const { getFirebaseConfig } = require("../lib/config");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  try {
    const decoded = await verifyTeacherToken(req.headers.authorization);

    const { maxSyllabusUploadBytes } = getFirebaseConfig();
    const approxBytes = Buffer.byteLength(req.body && req.body.fileBase64 ? req.body.fileBase64 : "", "utf8") * 0.75;
    if (approxBytes > maxSyllabusUploadBytes) {
      res.status(413).json({ error: `Syllabus file is too large (limit ${Math.round(maxSyllabusUploadBytes / 1024 / 1024)}MB).` });
      return;
    }

    const result = await buildKeywordBank(req.body, decoded.email);
    res.status(200).json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message || "Keyword bank generation failed." });
  }
};
