/**
 * tests/material-pipeline.test.js
 * ---------------------------------------------------------------------------
 * Tests for the §2/§3 material pipeline: lib/documentTextExtractor.js (now
 * handling txt/md/json as well as pdf/docx) and lib/materialProcessor.js's
 * metadata validation.
 *
 * Pure Node — no network, no Firebase, no Gemini. The two halves that DO reach
 * out (materialStore's Firestore/Storage writes, materialProcessor's Gemini
 * call) are deliberately not exercised here: they need real credentials, and
 * mocking the Admin SDK would test the mock. What IS tested is every pure
 * function between the upload and the stored record, which is where the
 * format handling and the drop-don't-coerce validation live.
 *
 * Run it:
 *     cd csa65-quiz-app
 *     node tests/material-pipeline.test.js
 * ---------------------------------------------------------------------------
 */

const assert = require("assert");

const Extractor = require("../lib/documentTextExtractor");
const Processor = require("../lib/materialProcessor");
const Store = require("../lib/materialStore");

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// ---------------------------------------------------------------------------
// Extraction — the new formats required by §2
// ---------------------------------------------------------------------------

(async () => {

await testAsync("extracts plain .txt", async () => {
  const r = await Extractor.extractText(b64("Unit 1 covers tokenization and embeddings in detail."), "notes.txt");
  assert.strictEqual(r.extension, "txt");
  assert.ok(r.text.includes("tokenization"));
  assert.strictEqual(r.charCount, r.text.length);
});

await testAsync("extracts .md and PRESERVES its markdown structure", async () => {
  // The headings and bullets are structure the metadata extractor uses, so
  // stripping them would lose signal rather than clean the input up.
  const md = "# Unit 1\n\n## Topics\n- Tokenization\n- Embeddings\n\nSome prose about transformers.";
  const r = await Extractor.extractText(b64(md), "syllabus.md");
  assert.strictEqual(r.extension, "md");
  assert.ok(r.text.includes("# Unit 1"), "heading markers must survive");
  assert.ok(r.text.includes("- Tokenization"), "list markers must survive");
});

await testAsync("accepts .markdown as well as .md", async () => {
  const r = await Extractor.extractText(b64("# Heading\n\nbody text that is long enough"), "a.markdown");
  assert.strictEqual(r.extension, "markdown");
});

await testAsync("renders generic .json as readable prose, not raw JSON", async () => {
  const doc = { course: "CSA65", topics: ["Tokenization", "Embeddings"], meta: { unit: "I" } };
  const r = await Extractor.extractText(b64(JSON.stringify(doc)), "spec.json");
  assert.ok(!r.text.includes('{"'), "braces/quotes are noise to the LLM and must not survive");
  assert.ok(r.text.includes("CSA65"));
  assert.ok(r.text.includes("- Tokenization"));
  assert.ok(r.text.includes("unit: I"), "nested objects must be flattened, got:\n" + r.text);
});

await testAsync("recognises the app's own question-bank export and renders it as questions", async () => {
  const bank = {
    unit: "I", unitTitle: "Fundamentals",
    questions: [{
      topic: "Tokenization", question: "What is BPE?",
      options: ["A", "B"], modelAnswer: "Byte pair encoding merges frequent pairs.",
      explanation: "It is a subword algorithm.", keywords: ["subword", "merge"],
    }],
  };
  const r = await Extractor.extractText(b64(JSON.stringify(bank)), "questions-unit1.json");
  assert.ok(r.text.includes("Unit title: Fundamentals"));
  assert.ok(r.text.includes("1. [Tokenization] What is BPE?"));
  assert.ok(r.text.includes("a) A"), "options should be lettered");
  assert.ok(r.text.includes("Model answer:"), "modelAnswer is the richest concept statement in a bank");
  assert.ok(r.text.includes("Key terms: subword, merge"));
});

await testAsync('skips the "_comment" convention used across data/*.json', async () => {
  const doc = { _comment: "DO NOT SHOW THIS TO THE MODEL", realField: "this is the actual content here" };
  const r = await Extractor.extractText(b64(JSON.stringify(doc)), "cfg.json");
  assert.ok(!r.text.includes("DO NOT SHOW"), "underscore-prefixed keys must be skipped");
  assert.ok(r.text.includes("this is the actual content"));
});

await testAsync("rejects an unsupported extension, naming the ones that work", async () => {
  await assert.rejects(
    () => Extractor.extractText(b64("whatever content goes here"), "slides.pptx"),
    (e) => e.statusCode === 400 && /pdf, docx, txt, md, markdown, json/.test(e.message)
  );
});

await testAsync("rejects malformed .json with the parser's own reason", async () => {
  await assert.rejects(
    () => Extractor.extractText(b64("{not valid json at all,,,}"), "broken.json"),
    (e) => e.statusCode === 400 && /is not valid JSON/.test(e.message)
  );
});

await testAsync("rejects an empty file", async () => {
  await assert.rejects(() => Extractor.extractText(b64(""), "empty.txt"), (e) => e.statusCode === 400);
});

await testAsync("rejects a file with too little text to be useful", async () => {
  await assert.rejects(
    () => Extractor.extractText(b64("hi"), "tiny.txt"),
    (e) => e.statusCode === 400 && /no usable text/.test(e.message)
  );
});

// A structurally valid single-page PDF whose content stream draws nothing —
// what a page of scanned images parses to (pdf-parse returns "\n\n"). Inlined
// as base64 rather than committed as a binary fixture so this suite stays
// dependency-free and self-contained.
//
// It needs the binary-marker comment after the header, a real /Contents
// stream, and CRLF-terminated xref entries: pdf.js (which pdf-parse wraps) is
// strict enough to reject a hand-written PDF missing any of the three, and
// then the failure is a parse error rather than the empty-text case this is
// meant to exercise.
const BLANK_PDF_B64 =
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9i" +
  "ago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2Uv" +
  "UGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PD4+L0NvbnRlbnRzIDQgMCBSPj4K" +
  "ZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDM1Pj4Kc3RyZWFtCjAuNSAwLjUgMC41IHJnCjcyIDYwMCA0NjggMTIw" +
  "IHJlCmYKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQ0KMDAwMDAwMDAwMCA2NTUzNSBmDQowMDAwMDAwMDE1IDAw" +
  "MDAwIG4NCjAwMDAwMDAwNjAgMDAwMDAgbg0KMDAwMDAwMDExMSAwMDAwMCBuDQowMDAwMDAwMjA1IDAwMDAwIG4N" +
  "CnRyYWlsZXIKPDwvU2l6ZSA1L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMjg3CiUlRU9GCg==";

await testAsync("REGRESSION: PDFs still parse with firebase-admin loaded in the process", async () => {
  // lib/materialStore.js (required at the top of this file) pulls in
  // firebase-admin, after which pdf.js rejects a Node Buffer with a bogus
  // "bad XRef entry" on perfectly valid files. api/upload-material.js loads
  // both, so this combination is exactly production — and before the
  // Uint8Array fix in documentTextExtractor.js, EVERY PDF upload failed with
  // an error blaming the teacher's file.
  //
  // The fixture below is a valid one-page PDF containing real text.
  const TEXT_PDF_B64 =
    "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9i" +
    "ago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2Uv" +
    "UGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+" +
    "L0NvbnRlbnRzIDQgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDkwPj4Kc3RyZWFtCkJUIC9GMSAxOCBU" +
    "ZiA3MiA3MDAgVGQgKFVuaXQgMSBUb2tlbml6YXRpb24gYW5kIEVtYmVkZGluZ3MgaW4gTGFyZ2UgTGFuZ3VhZ2Ug" +
    "TW9kZWxzKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEv" +
    "QmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2DQowMDAwMDAwMDAwIDY1NTM1IGYNCjAwMDAwMDAw" +
    "MTUgMDAwMDAgbg0KMDAwMDAwMDA2MCAwMDAwMCBuDQowMDAwMDAwMTExIDAwMDAwIG4NCjAwMDAwMDAyMjMgMDAw" +
    "MDAgbg0KMDAwMDAwMDM2MSAwMDAwMCBuDQp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVm" +
    "CjQyNAolJUVPRgo=";
  const r = await Extractor.extractText(TEXT_PDF_B64, "lecture.pdf");
  assert.strictEqual(r.extension, "pdf");
  assert.ok(/Tokenization/.test(r.text), `expected real text back, got: ${JSON.stringify(r.text)}`);
});

await testAsync("a text-free PDF is diagnosed as a scan needing OCR", async () => {
  // A real scanned PDF parses fine and yields "". Without this check an empty
  // prompt would reach Gemini and come back with confident, baseless metadata.
  await assert.rejects(
    () => Extractor.extractText(BLANK_PDF_B64, "scan.pdf"),
    (e) => e.statusCode === 400 && /run OCR on it first/.test(e.message)
  );
});

await testAsync("a CORRUPT pdf gives an actionable 400, not a raw parser exception", async () => {
  // Distinct from the scan case above: here the parser itself throws. pdf-parse
  // raises "bad XRef entry" with no statusCode, which unwrapped would reach the
  // teacher as a generic 500 "Processing failed" — useless, when the commonest
  // cause is a file renamed to the wrong extension.
  const corrupt = Buffer.from("%PDF-1.4\nthis is not actually a pdf body\n%%EOF", "latin1").toString("base64");
  await assert.rejects(
    () => Extractor.extractText(corrupt, "broken.pdf"),
    (e) => e.statusCode === 400 &&
           /could not be read as a PDF/.test(e.message) &&
           /damaged, password-protected, or saved in a different format/.test(e.message)
  );
});

await testAsync("a .docx that is not really a docx also gives an actionable 400", async () => {
  await assert.rejects(
    () => Extractor.extractText(b64("I am plain text pretending to be a Word file"), "fake.docx"),
    (e) => e.statusCode === 400 && /could not be read as a Word document/.test(e.message)
  );
});

// ---------------------------------------------------------------------------
// Metadata validation — drop, never coerce
// ---------------------------------------------------------------------------

test("accepts a well-formed knowledge object and keeps every §3 field", () => {
  const { metadata } = Processor.validateMetadata({
    subject: "Generative AI", unit: "Unit 1",
    topics: ["Tokenization", "Embeddings"],
    learning_outcomes: ["Explain how tokenization works"],
    course_outcomes: [{ code: "CO1", description: "Understand LLM foundations" }],
    important_concepts: [{ concept: "Byte pair encoding", importance: "high", topic: "Tokenization" }],
    keywords: ["BPE", "subword"],
    technical_terms: ["vocabulary", "token id"],
    definitions: [{ term: "Token", definition: "A unit of text processed by the model." }],
    expected_answer_concepts: [{ topic: "Tokenization", concepts: ["subword units", "vocabulary size"] }],
  });
  // Exactly the field list §3 asks for.
  assert.deepStrictEqual(Object.keys(metadata).sort(), [
    "course_outcomes", "definitions", "expected_answer_concepts", "important_concepts",
    "keywords", "learning_outcomes", "subject", "technical_terms", "topics", "unit",
  ]);
  assert.strictEqual(metadata.important_concepts[0].importance, "high");
});

test("drops malformed entries instead of coercing them into plausible values", () => {
  const { metadata } = Processor.validateMetadata({
    topics: ["Valid", "", null, 42, "  ", "Another"],
    definitions: [
      { term: "Good", definition: "has both halves" },
      { term: "NoDefinition" },                 // missing definition -> dropped
      { definition: "no term" },                // missing term -> dropped
    ],
    course_outcomes: [{ code: "CO1", description: "ok" }, { code: "CO2" }],
    expected_answer_concepts: [
      { topic: "T1", concepts: ["a", "b"] },
      { topic: "T2", concepts: [] },            // no concepts -> dropped
    ],
  });
  assert.deepStrictEqual(metadata.topics, ["Valid", "Another"]);
  assert.strictEqual(metadata.definitions.length, 1);
  assert.strictEqual(metadata.course_outcomes.length, 1, "a CO with no description is not a CO");
  assert.strictEqual(metadata.expected_answer_concepts.length, 1);
});

test("deduplicates case-insensitively while keeping the first spelling", () => {
  const { metadata } = Processor.validateMetadata({ topics: ["Tokenization", "tokenization", "TOKENIZATION", "Embeddings"] });
  assert.deepStrictEqual(metadata.topics, ["Tokenization", "Embeddings"]);
});

test("an unknown importance falls back to medium rather than being dropped", () => {
  // The concept itself is still useful even when the model invents a level.
  const { metadata } = Processor.validateMetadata({
    important_concepts: [{ concept: "Attention", importance: "critical", topic: "Transformers" }],
  });
  assert.strictEqual(metadata.important_concepts[0].importance, "medium");
});

test("caps runaway lists at the documented limits", () => {
  const { metadata } = Processor.validateMetadata({
    topics: Array.from({ length: 200 }, (_, i) => `Topic ${i}`),
  });
  assert.strictEqual(metadata.topics.length, Processor.LIMITS.topics);
});

test("warns rather than throws when the model returns nothing useful", () => {
  // §3 puts a human review step between processing and publishing precisely
  // so a thin result is catchable — partial metadata is still worth editing.
  const { metadata, warnings } = Processor.validateMetadata({});
  assert.deepStrictEqual(metadata.topics, []);
  assert.ok(warnings.some((w) => /No topics were extracted/.test(w)));
  assert.ok(warnings.some((w) => /No expected-answer concepts/.test(w)));
});

test("throws only when the response is not an object at all", () => {
  assert.throws(() => Processor.validateMetadata(null), /did not return a metadata object/);
  assert.throws(() => Processor.validateMetadata([1, 2]), /did not return a metadata object/);
});

test("the metadata prompt tells the model not to parrot the teacher's hints back", () => {
  const prompt = Processor.buildMetadataPrompt({
    materialText: "content", filename: "f.pdf", subjectHint: "csa65", unitHint: "csa65-u1", truncated: false,
  });
  assert.ok(/Treat these as context only/.test(prompt),
    "a hint without this instruction biases the model into reporting the hint regardless of the file");
  assert.ok(/Ground EVERYTHING strictly in the supplied material/.test(prompt));
});

// ---------------------------------------------------------------------------
// Store helpers (the pure ones)
// ---------------------------------------------------------------------------

test("material ids are generated, never derived from the filename", () => {
  // Two units can legitimately both hold an "Unit1_Syllabus.pdf".
  const a = Store.newMaterialId(), b = Store.newMaterialId();
  assert.notStrictEqual(a, b);
  assert.ok(/^mat-[a-z0-9]+-[0-9a-f]{8}$/.test(a), `unexpected id shape: ${a}`);
});

test("filenames are sanitised into safe Storage object paths", () => {
  assert.strictEqual(Store.safeFilename("Unit 1 Syllabus.pdf"), "Unit_1_Syllabus.pdf");
  assert.strictEqual(Store.safeFilename("../../etc/passwd"), ".._.._etc_passwd");
  assert.ok(!Store.safeFilename("a/b/c.pdf").includes("/"), "path separators must not survive");
  assert.strictEqual(Store.safeFilename(""), "material");
});

test("content hashing ignores line-ending and trailing-whitespace churn", () => {
  // A teacher re-saving the same document on Windows must not look like a
  // content change, or it would re-bill a Gemini run for nothing.
  assert.strictEqual(Store.hashText("a\r\nb"), Store.hashText("a\nb"));
  assert.strictEqual(Store.hashText("  text  "), Store.hashText("text"));
  assert.notStrictEqual(Store.hashText("a"), Store.hashText("b"));
});

test("every supported extension has a real content type", () => {
  Extractor.SUPPORTED_EXTENSIONS.forEach((ext) => {
    assert.notStrictEqual(Store.contentTypeFor(ext), "application/octet-stream",
      `${ext} is accepted by the extractor but has no content type in materialStore`);
  });
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.ok ? "" : `\n          ${r.error}`}`));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

})();
