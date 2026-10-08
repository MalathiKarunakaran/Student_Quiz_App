// DocumentTextExtractor — turns an uploaded assessment/syllabus file into
// plain text so it can be hashed, stored, and fed to Gemini. Kept separate
// from the API handlers so the extraction step (and its two heavyweight
// dependencies) can be reasoned about/replaced independently, the same way
// lib/githubRetriever.js is a focused single-purpose module.
//
// Formats, per requirement §2: pdf, docx, txt, md, json.
//   - pdf/docx need real parsers (pdf-parse, mammoth)
//   - txt/md are already text; they are decoded, not parsed
//   - json is flattened to readable text rather than dumped raw, because the
//     LLM reads this downstream and `{"a":1}` punctuation is noise to it.
//     A question-bank-shaped JSON (the app's own export format) is recognised
//     and rendered as prose, so a teacher can re-upload an exported bank as
//     source material and have it read as questions rather than as a blob.

const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");

// Keep this list and the <input accept="..."> in the teacher UI in sync.
const SUPPORTED_EXTENSIONS = ["pdf", "docx", "txt", "md", "markdown", "json"];

// A text file that decodes to this little content is almost always a wrong
// upload (an empty file, or a binary renamed to .txt). Better to reject it
// here than to send meaningless context to Gemini and bill for it.
const MIN_USEFUL_CHARS = 20;

function detectExtension(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(filename || "");
  return match ? match[1].toLowerCase() : "";
}

function decodeBase64(fileBase64) {
  let buffer;
  try {
    buffer = Buffer.from(fileBase64, "base64");
  } catch (e) {
    const err = new Error("Could not decode the uploaded file — it may not be valid base64.");
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length === 0) {
    const err = new Error("The uploaded file is empty.");
    err.statusCode = 400;
    throw err;
  }
  return buffer;
}

/**
 * Renders arbitrary JSON as indented, readable lines.
 *
 * Deliberately not JSON.stringify(obj, null, 2): the braces, quotes and commas
 * are pure noise to a language model reading this as source material, and they
 * consume a meaningful share of the prompt budget on a large file.
 */
function jsonToReadableText(value, depth = 0) {
  const pad = "  ".repeat(depth);

  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rendered = jsonToReadableText(item, depth + 1);
        return typeof item === "object" && item !== null ? `${pad}-\n${rendered}` : `${pad}- ${rendered}`;
      })
      .join("\n");
  }

  return Object.entries(value)
    .filter(([key]) => !key.startsWith("_")) // skip the "_comment" convention used across data/*.json
    .map(([key, val]) => {
      const label = key.replace(/[_-]+/g, " ");
      if (val === null || val === undefined) return "";
      if (typeof val !== "object") return `${pad}${label}: ${val}`;
      return `${pad}${label}:\n${jsonToReadableText(val, depth + 1)}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Runs a binary-format parser and converts its failure into an actionable 400.
 *
 * pdf-parse and mammoth both throw low-level exceptions on a damaged or
 * mislabelled file ("bad XRef entry", "Could not find the body element") with
 * no statusCode attached. Unwrapped, those reach the teacher as a generic
 * 500 "Processing failed", which says nothing about what to do next — and the
 * commonest cause by far is a file renamed to the wrong extension, which is
 * entirely the teacher's to fix.
 */
async function parseOrExplain(parseFn, filename, formatLabel) {
  try {
    return await parseFn();
  } catch (e) {
    const err = new Error(
      `"${filename}" could not be read as a ${formatLabel} — the file may be damaged, ` +
      `password-protected, or saved in a different format than its extension suggests. ` +
      `(${formatLabel} reader: ${e.message})`
    );
    err.statusCode = 400;
    throw err;
  }
}

/** Recognises this app's own question-bank export and renders it as prose. */
function questionBankToText(parsed) {
  const header = [
    parsed.unitTitle ? `Unit title: ${parsed.unitTitle}` : "",
    parsed.unit ? `Unit: ${parsed.unit}` : "",
  ].filter(Boolean).join("\n");

  const body = parsed.questions.map((q, i) => {
    const lines = [`${i + 1}. [${q.topic || "untagged"}] ${q.question || ""}`];
    if (Array.isArray(q.options) && q.options.length) {
      lines.push(...q.options.map((o, oi) => `   ${String.fromCharCode(97 + oi)}) ${o}`));
    }
    // modelAnswer and explanation are the richest statements of the intended
    // concepts in a bank, which is exactly what downstream metadata extraction
    // is looking for.
    if (q.modelAnswer) lines.push(`   Model answer: ${q.modelAnswer}`);
    if (q.explanation) lines.push(`   Explanation: ${q.explanation}`);
    if (Array.isArray(q.keywords) && q.keywords.length) lines.push(`   Key terms: ${q.keywords.join(", ")}`);
    return lines.join("\n");
  }).join("\n\n");

  return [header, body].filter(Boolean).join("\n\n");
}

/**
 * fileBase64: raw base64 payload (no "data:...;base64," prefix — strip that
 * client-side before sending, see js/teacher-config.js).
 * Returns { text, extension, charCount }.
 */
async function extractText(fileBase64, filename) {
  const extension = detectExtension(filename);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    const err = new Error(
      `Unsupported file type "${extension || "unknown"}" — upload one of: ${SUPPORTED_EXTENSIONS.join(", ")}.`
    );
    err.statusCode = 400;
    throw err;
  }

  const buffer = decodeBase64(fileBase64);
  let text;

  switch (extension) {
    case "docx": {
      text = await parseOrExplain(
        async () => (await mammoth.extractRawText({ buffer })).value,
        filename, "Word document"
      );
      break;
    }
    case "pdf": {
      // new Uint8Array(buffer), NOT the Buffer itself. This is load-bearing.
      //
      // pdf-parse wraps pdf.js, which does byte-level indexing and
      // `instanceof Uint8Array` checks on its input. A Node Buffer normally
      // satisfies those — but once firebase-admin has been required into the
      // same process, pdf.js rejects a Buffer with a bogus "bad XRef entry"
      // on files that parse perfectly well otherwise. api/upload-material.js
      // requires BOTH (firebase-admin via lib/materialStore.js), so passing a
      // Buffer here meant every PDF upload failed in production with an error
      // message blaming the teacher's file.
      //
      // The copy is cheap relative to parsing and removes the interaction
      // entirely. Verified both ways in tests/material-pipeline.test.js.
      text = await parseOrExplain(
        async () => (await pdfParse(new Uint8Array(buffer))).text,
        filename, "PDF"
      );
      break;
    }
    case "json": {
      const raw = buffer.toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        const err = new Error(`"${filename}" is not valid JSON: ${e.message}`);
        err.statusCode = 400;
        throw err;
      }
      text = (parsed && Array.isArray(parsed.questions))
        ? questionBankToText(parsed)
        : jsonToReadableText(parsed);
      break;
    }
    default: {
      // txt, md, markdown — already text. Markdown is passed through with its
      // syntax intact: the headings and list markers are structure the
      // metadata extractor can actually use, so stripping them loses signal.
      text = buffer.toString("utf8");
      break;
    }
  }

  // A PDF of scanned page images parses to almost nothing. Saying so here is
  // far more useful than letting an empty prompt reach Gemini and produce
  // confident, baseless metadata.
  const normalized = (text || "").trim();
  if (normalized.length < MIN_USEFUL_CHARS) {
    const err = new Error(
      extension === "pdf"
        ? `No readable text could be extracted from "${filename}". If it is a scan of printed pages, ` +
          `the text layer is missing — run OCR on it first, or upload the source document instead.`
        : `"${filename}" contained no usable text (${normalized.length} characters).`
    );
    err.statusCode = 400;
    throw err;
  }

  return { text: normalized, extension, charCount: normalized.length };
}

module.exports = {
  extractText, detectExtension, jsonToReadableText, questionBankToText,
  SUPPORTED_EXTENSIONS, MIN_USEFUL_CHARS,
};
