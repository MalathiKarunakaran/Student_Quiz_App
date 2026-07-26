// DocumentTextExtractor — turns an uploaded syllabus file (.docx or .pdf,
// received as base64) into plain text so it can be hashed and fed to Gemini.
// Kept separate from api/generate-keywords.js so the extraction step (and its
// two extra dependencies) can be reasoned about/replaced independently, the
// same way lib/githubRetriever.js is a focused single-purpose module.

const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

const SUPPORTED_EXTENSIONS = ["docx", "pdf"];

function detectExtension(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(filename || "");
  return match ? match[1].toLowerCase() : "";
}

// fileBase64: raw base64 payload (no "data:...;base64," prefix — strip that
// client-side before sending, see js/teacher-config.js).
async function extractText(fileBase64, filename) {
  const extension = detectExtension(filename);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    const err = new Error(`Unsupported syllabus file type "${extension || "unknown"}" — upload a .docx or .pdf file.`);
    err.statusCode = 400;
    throw err;
  }

  let buffer;
  try {
    buffer = Buffer.from(fileBase64, "base64");
  } catch (e) {
    const err = new Error("Could not decode the uploaded file — it may not be valid base64.");
    err.statusCode = 400;
    throw err;
  }

  if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // extension === "pdf"
  const result = await pdfParse(buffer);
  return result.text;
}

module.exports = { extractText, detectExtension, SUPPORTED_EXTENSIONS };
