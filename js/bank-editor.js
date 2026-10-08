/**
 * bank-editor.js
 * ---------------------------------------------------------------------------
 * In-browser question bank editor for teacher.html (README Section 30).
 *
 * Before this, changing a question meant hand-editing `data/questions-*.json`
 * — getting the per-type field combinations right from memory, and committing
 * to the repo for every typo. Worse, questions produced by the Hermes AI agent
 * were appended to an in-memory array that nothing ever persisted, so they
 * never reached a student at all.
 *
 * This module owns a working copy of one bank and renders two things:
 *   - a list of every question (searchable, with inline validity state), and
 *   - a form for the selected question whose fields follow its `type`.
 *
 * It deliberately does NOT re-implement the schema. Validation calls
 * `QuestionValidator` (lib/questionValidator.js), the same module the server
 * uses on LLM output — see the dual-mode note at the top of that file. A
 * browser-only copy of those rules would be free to drift, and the drift would
 * surface as a question that saves cleanly here and then breaks in front of a
 * student.
 *
 * Saving has two independent targets (neither requires the other):
 *   - Firestore  — live: the change reaches students on their next load, with
 *                  no commit and no redeploy. Requires teacher sign-in.
 *   - Download   — the same bank as a `questions-*.json` file to commit, which
 *                  keeps working with no Firebase at all.
 * ---------------------------------------------------------------------------
 */

const BankEditor = (() => {
  const DRAFT_KEY_PREFIX = "csa65bankdraft::";

  /** Fields every question has, in the order the form shows them. */
  const COMMON_FIELDS = ["id", "unit", "topic", "type", "difficulty", "bloom", "marks", "co"];

  /**
   * Which extra fields each type uses. Drives both the form (what to show) and
   * the save step (what to strip), so a question switched from `mcq` to
   * `descriptive` doesn't silently keep a stale `correctAnswer` that the
   * scorer would then read.
   */
  const TYPE_FIELDS = {
    mcq:              ["options", "correctAnswer"],
    truefalse:        ["correctAnswerBool"],
    multiselect:      ["options", "correctAnswers"],
    fillblank:        ["acceptableAnswers", "caseSensitive"],
    descriptive:      ["keywords", "minKeywordsForFullMarks", "modelAnswer"],
    scenario:         ["keywords", "minKeywordsForFullMarks", "modelAnswer"],
    promptengineering:["keywords", "minKeywordsForFullMarks", "modelAnswer"],
    codeoutput:       ["codeSnippet", "runnable", "acceptableAnswers", "caseSensitive"],
    // Both answer shapes are offered: a debugging question can be closed-form
    // (acceptableAnswers) or open-ended (keywords + modelAnswer), and the
    // snippet is optional because the bug may be described in prose.
    debugging:        ["codeSnippet", "runnable", "acceptableAnswers", "keywords", "minKeywordsForFullMarks", "modelAnswer"],
  };

  const DIFFICULTIES = ["easy", "medium", "hard"];
  const BLOOMS = ["remember", "understand", "apply", "analyze", "evaluate", "create"];

  let bank = null;        // { unit, unitTitle, questions: [...] }
  let bankId = "";        // Firestore document id / file stem
  let selectedIndex = -1;
  let searchTerm = "";
  let dirty = false;
  let onBankChanged = () => {};

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * Adopts `rawBank` as the working copy. Deep-cloned so editing never mutates
   * the array teacher-config.js is simultaneously filtering on — the two views
   * are intentionally decoupled until the instructor saves.
   */
  function load(rawBank, id) {
    bank = {
      unit: rawBank.unit || "",
      unitTitle: rawBank.unitTitle || "",
      questions: JSON.parse(JSON.stringify(rawBank.questions || [])),
    };
    bankId = id || "";
    selectedIndex = bank.questions.length ? 0 : -1;
    dirty = false;
    render();
  }

  function getBank() { return bank; }
  function isDirty() { return dirty; }
  function setOnBankChanged(fn) { onBankChanged = fn || (() => {}); }

  function markDirty() {
    dirty = true;
    saveDraft();
    onBankChanged(bank);
  }

  // -------------------------------------------------------------------------
  // Draft persistence
  // -------------------------------------------------------------------------

  /**
   * Autosaves to localStorage on every edit. A teacher part-way through
   * rewriting twenty questions should not lose that to an accidental tab
   * close — the same reasoning that already protects a student's in-progress
   * answers in js/storage.js.
   */
  function saveDraft() {
    if (!bank) return;
    try {
      localStorage.setItem(DRAFT_KEY_PREFIX + (bankId || "untitled"),
        JSON.stringify({ savedAt: new Date().toISOString(), bank }));
    } catch (e) { /* quota or private mode — editing still works, just unprotected */ }
  }

  function readDraft(id) {
    try {
      const raw = localStorage.getItem(DRAFT_KEY_PREFIX + (id || "untitled"));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function discardDraft(id) {
    try { localStorage.removeItem(DRAFT_KEY_PREFIX + (id || "untitled")); } catch (e) {}
  }

  function clearDirty() { dirty = false; discardDraft(bankId); }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /** Schema reasons from the shared validator, plus the two things it can't see. */
  function problemsFor(index) {
    const q = bank.questions[index];
    const reasons = QuestionValidator.validateOne(q);

    // Uniqueness is a property of the bank, not of one question, so the shared
    // validator has no way to check it — but a duplicate id silently breaks
    // answer storage, which is keyed by question id (js/quiz-engine.js).
    if (!q.id || !String(q.id).trim()) {
      reasons.push("id is required");
    } else if (bank.questions.some((other, i) => i !== index && other.id === q.id)) {
      reasons.push(`duplicate id "${q.id}" — ids must be unique within a bank`);
    }
    return reasons;
  }

  function allProblems() {
    return bank.questions
      .map((q, i) => ({ index: i, id: q.id, reasons: problemsFor(i) }))
      .filter(p => p.reasons.length > 0);
  }

  /**
   * Near-duplicate question text, via the same Jaccard similarity the server
   * uses to dedupe LLM output (lib/duplicateChecker.js). A warning, never a
   * block: two questions can legitimately be close variants.
   */
  function nearDuplicates() {
    if (typeof DuplicateChecker === "undefined") return [];
    const out = [];
    for (let i = 0; i < bank.questions.length; i++) {
      for (let j = i + 1; j < bank.questions.length; j++) {
        const score = DuplicateChecker.similarity(bank.questions[i].question, bank.questions[j].question);
        if (score >= 0.85) out.push({ a: i, b: j, score });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /** Next free id of the form `<prefix><type>-NNN`, matching the shipped bank's scheme. */
  function nextId(type) {
    const unitPrefix = "u" + String(bank.unit || "1").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    let n = 1;
    let candidate;
    do {
      candidate = `${unitPrefix}-${type}-${String(n).padStart(3, "0")}`;
      n++;
    } while (bank.questions.some(q => q.id === candidate));
    return candidate;
  }

  function addQuestion(type = "mcq") {
    const q = {
      id: nextId(type),
      unit: bank.unit || "",
      topic: "",
      type,
      difficulty: "easy",
      bloom: "remember",
      marks: 1,
      co: firstExistingCo(),
      question: "",
      explanation: "",
    };
    applyTypeDefaults(q);
    bank.questions.push(q);
    selectedIndex = bank.questions.length - 1;
    markDirty();
    render();
    focusFirstField();
  }

  function firstExistingCo() {
    const existing = bank.questions.find(q => q.co);
    return existing ? existing.co : "CO1";
  }

  function duplicateQuestion(index) {
    const copy = JSON.parse(JSON.stringify(bank.questions[index]));
    copy.id = nextId(copy.type);
    bank.questions.splice(index + 1, 0, copy);
    selectedIndex = index + 1;
    markDirty();
    render();
  }

  function deleteQuestion(index) {
    bank.questions.splice(index, 1);
    if (selectedIndex >= bank.questions.length) selectedIndex = bank.questions.length - 1;
    markDirty();
    render();
  }

  function moveQuestion(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= bank.questions.length) return;
    const [q] = bank.questions.splice(index, 1);
    bank.questions.splice(target, 0, q);
    selectedIndex = target;
    markDirty();
    render();
  }

  /** Seeds the fields a type needs and removes the ones it doesn't. */
  function applyTypeDefaults(q) {
    const keep = new Set([...COMMON_FIELDS, "question", "explanation", ...(TYPE_FIELDS[q.type] || [])]);
    // `correctAnswerBool` is a form-only alias: truefalse stores a boolean in
    // `correctAnswer`, the same field mcq uses for an index.
    if (keep.has("correctAnswerBool")) keep.add("correctAnswer");

    for (const key of Object.keys(q)) {
      if (!keep.has(key)) delete q[key];
    }

    const needs = TYPE_FIELDS[q.type] || [];
    if (needs.includes("options") && !Array.isArray(q.options)) q.options = ["", "", "", ""];
    if (needs.includes("correctAnswer") && !Number.isInteger(q.correctAnswer)) q.correctAnswer = 0;
    if (needs.includes("correctAnswerBool") && typeof q.correctAnswer !== "boolean") q.correctAnswer = true;
    if (needs.includes("correctAnswers") && !Array.isArray(q.correctAnswers)) q.correctAnswers = [];
    if (needs.includes("acceptableAnswers") && !Array.isArray(q.acceptableAnswers)) q.acceptableAnswers = [];
    if (needs.includes("keywords") && !Array.isArray(q.keywords)) q.keywords = [];
    if (needs.includes("minKeywordsForFullMarks") && typeof q.minKeywordsForFullMarks !== "number") {
      q.minKeywordsForFullMarks = Math.max(1, Math.min(3, (q.keywords || []).length || 3));
    }
    if (needs.includes("modelAnswer") && typeof q.modelAnswer !== "string") q.modelAnswer = "";
    if (needs.includes("codeSnippet") && typeof q.codeSnippet !== "string") q.codeSnippet = "";
    if (needs.includes("caseSensitive") && typeof q.caseSensitive !== "boolean") q.caseSensitive = false;
  }

  function changeType(index, newType) {
    const q = bank.questions[index];
    q.type = newType;
    applyTypeDefaults(q);
    markDirty();
    render();
  }

  /** Appends questions from elsewhere (the Hermes AI agent) into the working copy. */
  function appendQuestions(questions) {
    const added = [];
    for (const raw of questions) {
      const q = JSON.parse(JSON.stringify(raw));
      if (!q.id || bank.questions.some(e => e.id === q.id)) q.id = nextId(q.type || "mcq");
      if (!q.unit) q.unit = bank.unit || "";
      bank.questions.push(q);
      added.push(q.id);
    }
    if (added.length) {
      selectedIndex = bank.questions.length - added.length;
      markDirty();
      render();
    }
    return added;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return node;
  }

  function render() {
    if (!bank) return;
    renderMeta();
    renderList();
    renderForm();
    renderStatus();
  }

  function renderMeta() {
    const unitEl = document.getElementById('editorUnit');
    const titleEl = document.getElementById('editorUnitTitle');
    if (unitEl && unitEl.value !== bank.unit) unitEl.value = bank.unit;
    if (titleEl && titleEl.value !== bank.unitTitle) titleEl.value = bank.unitTitle;
  }

  function matchesSearch(q) {
    if (!searchTerm) return true;
    const t = searchTerm.toLowerCase();
    return [q.id, q.question, q.topic, q.type, q.co].some(v => String(v || "").toLowerCase().includes(t));
  }

  function renderList() {
    const list = document.getElementById('editorList');
    if (!list) return;
    list.innerHTML = '';

    const visible = bank.questions
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => matchesSearch(q));

    if (visible.length === 0) {
      list.appendChild(el("div", { class: "editor-empty", text:
        bank.questions.length ? "No questions match your search." : "This bank has no questions yet. Use “+ Add Question” to create one." }));
      return;
    }

    for (const { q, i } of visible) {
      const problems = problemsFor(i);
      const row = el("button", {
        type: "button",
        class: "editor-row" + (i === selectedIndex ? " selected" : "") + (problems.length ? " invalid" : ""),
        onclick: () => { selectedIndex = i; render(); },
      });
      row.appendChild(el("span", { class: "editor-row-id", text: q.id || "(no id)" }));
      row.appendChild(el("span", { class: "editor-row-q", text: q.question || "(empty question)" }));
      row.appendChild(el("span", { class: "editor-row-type", text: q.type }));
      if (problems.length) {
        row.appendChild(el("span", {
          class: "editor-row-flag",
          title: problems.join("; "),
          text: `${problems.length} issue${problems.length > 1 ? "s" : ""}`,
        }));
      }
      list.appendChild(row);
    }
  }

  function field(labelText, control, hint) {
    const wrap = el("div", { class: "field" });
    wrap.appendChild(el("label", { text: labelText }));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el("div", { class: "editor-hint", text: hint }));
    return wrap;
  }

  function textInput(value, oninput, attrs = {}) {
    const input = el("input", { type: "text", ...attrs });
    input.value = value == null ? "" : value;
    input.addEventListener("input", () => oninput(input.value));
    return input;
  }

  function textArea(value, oninput, rows = 3, cls = "q-textarea") {
    const ta = el("textarea", { class: cls, rows });
    ta.value = value == null ? "" : value;
    ta.addEventListener("input", () => oninput(ta.value));
    return ta;
  }

  function select(options, value, onchange) {
    const sel = el("select");
    for (const opt of options) {
      const o = el("option", { value: opt.value != null ? opt.value : opt });
      o.textContent = opt.label != null ? opt.label : opt;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => onchange(sel.value));
    return sel;
  }

  function checkbox(labelText, checked, onchange) {
    const wrap = el("label", { class: "editor-check" });
    const box = el("input", { type: "checkbox" });
    box.checked = !!checked;
    box.addEventListener("change", () => onchange(box.checked));
    wrap.appendChild(box);
    wrap.appendChild(el("span", { text: labelText }));
    return wrap;
  }

  /** Comma/newline separated list ↔ array of strings. */
  function listInput(value, oninput, placeholder) {
    return textArea((value || []).join("\n"), (raw) => {
      oninput(raw.split("\n").map(s => s.trim()).filter(Boolean));
    }, 3, "q-textarea editor-list-input");
  }

  function renderForm() {
    const host = document.getElementById('editorForm');
    if (!host) return;
    host.innerHTML = '';

    if (selectedIndex < 0 || !bank.questions[selectedIndex]) {
      host.appendChild(el("div", { class: "editor-empty", text: "Select a question on the left, or add a new one." }));
      return;
    }

    const q = bank.questions[selectedIndex];
    const set = (key) => (val) => { q[key] = val; markDirty(); renderList(); renderStatus(); };

    // --- identity / metadata ---
    const meta = el("div", { class: "grid2" });
    meta.appendChild(field("Question ID", textInput(q.id, (v) => {
      q.id = v.trim(); markDirty(); renderList(); renderStatus();
    }), "Must be unique in this bank — answers are stored against it."));
    meta.appendChild(field("Topic", textInput(q.topic, set("topic")), "Free text; drives the teacher panel's topic filter."));
    host.appendChild(meta);

    const meta2 = el("div", { class: "grid3" });
    meta2.appendChild(field("Type", select(QuestionValidator.VALID_TYPES, q.type,
      (v) => changeType(selectedIndex, v)), "Changing type clears fields the new type doesn't use."));
    meta2.appendChild(field("Difficulty", select(DIFFICULTIES, q.difficulty, set("difficulty"))));
    meta2.appendChild(field("Bloom Level", select(BLOOMS, q.bloom, set("bloom"))));
    host.appendChild(meta2);

    const meta3 = el("div", { class: "grid3" });
    const marksInput = el("input", { type: "number", min: "0.5", step: "0.5" });
    marksInput.value = q.marks;
    marksInput.addEventListener("input", () => {
      q.marks = parseFloat(marksInput.value); markDirty(); renderStatus();
    });
    meta3.appendChild(field("Marks", marksInput));
    meta3.appendChild(field("Course Outcome", textInput(q.co, set("co")), "e.g. CO1 — see README Section 22."));
    meta3.appendChild(field("Unit", textInput(q.unit, set("unit"))));
    host.appendChild(meta3);

    // --- question text ---
    host.appendChild(field("Question", textArea(q.question, set("question"), 4)));

    // --- per-type fields ---
    for (const key of (TYPE_FIELDS[q.type] || [])) {
      const control = renderTypeField(key, q, set);
      if (control) host.appendChild(control);
    }

    // --- explanation (shown to the student after submit) ---
    host.appendChild(field("Explanation", textArea(q.explanation, set("explanation"), 3),
      "Shown to the student after they submit."));

    // --- per-question validity ---
    const problems = problemsFor(selectedIndex);
    if (problems.length) {
      const box = el("div", { class: "error-box editor-problems" });
      box.appendChild(el("strong", { text: "This question can't be used yet:" }));
      const ul = el("ul");
      problems.forEach(r => ul.appendChild(el("li", { text: r })));
      box.appendChild(ul);
      host.appendChild(box);
    } else {
      host.appendChild(el("div", { class: "editor-valid", text: "✓ Valid against the Section 5.1 schema." }));
    }

    // --- row actions ---
    const actions = el("div", { class: "btn-row editor-actions" });
    actions.appendChild(el("button", { type: "button", class: "btn-secondary",
      onclick: () => moveQuestion(selectedIndex, -1), disabled: selectedIndex === 0, text: "↑ Move Up" }));
    actions.appendChild(el("button", { type: "button", class: "btn-secondary",
      onclick: () => moveQuestion(selectedIndex, 1),
      disabled: selectedIndex === bank.questions.length - 1, text: "↓ Move Down" }));
    actions.appendChild(el("button", { type: "button", class: "btn-secondary",
      onclick: () => duplicateQuestion(selectedIndex), text: "Duplicate" }));
    actions.appendChild(el("button", { type: "button", class: "btn-secondary editor-delete",
      onclick: () => confirmDelete(selectedIndex), text: "Delete" }));
    host.appendChild(actions);
  }

  function renderTypeField(key, q, set) {
    switch (key) {
      case "options":
        return renderOptionsEditor(q);

      case "correctAnswer":
        return null; // rendered inside the options editor, as a radio per option

      case "correctAnswers":
        return null; // rendered inside the options editor, as a checkbox per option

      case "correctAnswerBool":
        return field("Correct Answer", select(
          [{ value: "true", label: "True" }, { value: "false", label: "False" }],
          String(q.correctAnswer === true),
          (v) => { q.correctAnswer = (v === "true"); markDirty(); renderStatus(); }
        ));

      case "acceptableAnswers":
        return field("Acceptable Answers (one per line)",
          listInput(q.acceptableAnswers, set("acceptableAnswers")),
          q.type === "debugging"
            ? "Optional for debugging — leave empty to grade it as an open-ended keyword answer instead."
            : "A student's answer counts as correct if it matches any line.");

      case "caseSensitive":
        return field("Matching", checkbox("Case-sensitive", q.caseSensitive, set("caseSensitive")));

      case "keywords":
        return field("Keywords (one per line)", listInput(q.keywords, set("keywords")),
          "Used to score the open-ended answer — see README Section 9.");

      case "minKeywordsForFullMarks": {
        const input = el("input", { type: "number", min: "1", step: "1" });
        input.value = q.minKeywordsForFullMarks;
        input.addEventListener("input", () => {
          q.minKeywordsForFullMarks = parseInt(input.value, 10); markDirty(); renderStatus();
        });
        return field("Keywords Needed for Full Marks", input,
          `This question has ${(q.keywords || []).length} keyword(s).`);
      }

      case "modelAnswer":
        return field("Model Answer", textArea(q.modelAnswer, set("modelAnswer"), 4),
          "Shown to the instructor and in the student's PDF report, never during the quiz.");

      case "codeSnippet":
        return field("Code Snippet", textArea(q.codeSnippet, set("codeSnippet"), 6, "q-code-editor"),
          q.type === "debugging"
            ? "Optional — a debugging question may describe the bug in prose instead."
            : "Required for code-output questions.");

      case "runnable":
        return field("Python Sandbox", checkbox("Runnable in-browser (Pyodide)", q.runnable, set("runnable")),
          "If ticked, the snippet must be complete, self-contained, valid Python — see README Section 23.");

      default:
        return null;
    }
  }

  /**
   * Options plus their correctness marker in one control. They're rendered
   * together because the correct answer is an INDEX into this list: editing
   * them in two separate places is how an off-by-one answer key gets shipped.
   * Deleting an option therefore also repairs the stored indices here.
   */
  function renderOptionsEditor(q) {
    const multi = q.type === "multiselect";
    const wrap = el("div", { class: "field" });
    wrap.appendChild(el("label", { text: multi ? "Options (tick every correct one)" : "Options (tick the correct one)" }));

    (q.options || []).forEach((opt, i) => {
      const row = el("div", { class: "editor-option-row" });

      const marker = el("input", {
        type: multi ? "checkbox" : "radio",
        name: "correct-" + q.id,
        title: "Mark as correct",
      });
      marker.checked = multi
        ? (q.correctAnswers || []).includes(i)
        : q.correctAnswer === i;
      marker.addEventListener("change", () => {
        if (multi) {
          const set = new Set(q.correctAnswers || []);
          if (marker.checked) set.add(i); else set.delete(i);
          q.correctAnswers = [...set].sort((a, b) => a - b);
        } else {
          q.correctAnswer = i;
        }
        markDirty();
        renderForm();
        renderStatus();
      });
      row.appendChild(marker);

      const input = el("input", { type: "text", class: "editor-option-text" });
      input.value = opt;
      input.addEventListener("input", () => {
        q.options[i] = input.value; markDirty(); renderStatus();
      });
      row.appendChild(input);

      row.appendChild(el("button", {
        type: "button", class: "editor-option-remove", title: "Remove this option",
        text: "✕",
        onclick: () => removeOption(q, i),
      }));

      wrap.appendChild(row);
    });

    wrap.appendChild(el("button", {
      type: "button", class: "btn-secondary editor-add-option", text: "+ Add Option",
      onclick: () => { q.options.push(""); markDirty(); renderForm(); },
    }));

    return wrap;
  }

  /** Removes an option AND shifts the answer indices that pointed past it. */
  function removeOption(q, index) {
    q.options.splice(index, 1);
    if (q.type === "multiselect") {
      q.correctAnswers = (q.correctAnswers || [])
        .filter(i => i !== index)
        .map(i => (i > index ? i - 1 : i));
    } else {
      if (q.correctAnswer === index) q.correctAnswer = 0;
      else if (q.correctAnswer > index) q.correctAnswer -= 1;
    }
    markDirty();
    renderForm();
    renderStatus();
  }

  function confirmDelete(index) {
    const q = bank.questions[index];
    const host = document.getElementById('editorForm');
    const box = el("div", { class: "error-box editor-confirm" });
    box.appendChild(el("div", { text: `Delete “${(q.question || q.id).slice(0, 80)}”? This can't be undone.` }));
    const row = el("div", { class: "btn-row" });
    row.appendChild(el("button", { type: "button", class: "btn-secondary editor-delete",
      text: "Yes, delete it", onclick: () => deleteQuestion(index) }));
    row.appendChild(el("button", { type: "button", class: "btn-secondary",
      text: "Cancel", onclick: () => renderForm() }));
    box.appendChild(row);
    host.appendChild(box);
    box.scrollIntoView({ block: "nearest" });
  }

  function focusFirstField() {
    const first = document.querySelector('#editorForm input[type="text"]');
    if (first) first.focus();
  }

  function renderStatus() {
    const el_ = document.getElementById('editorStatus');
    if (!el_ || !bank) return;
    const problems = allProblems();
    const dupes = nearDuplicates();

    const parts = [`${bank.questions.length} question${bank.questions.length === 1 ? "" : "s"}`];
    if (problems.length) parts.push(`${problems.length} with problems`);
    else parts.push("all valid");
    if (dupes.length) parts.push(`${dupes.length} near-duplicate pair${dupes.length === 1 ? "" : "s"}`);
    if (dirty) parts.push("unsaved changes");

    el_.textContent = parts.join(" · ");
    el_.className = "editor-status" + (problems.length ? " has-problems" : "");
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * The bank as it should be stored. Numbers are coerced here because a
   * number <input> hands back a string on some paths, and Firestore would then
   * store `marks: "2"` — which `Scorer` would happily add to a running total
   * as string concatenation.
   */
  function toSaveable() {
    return {
      unit: bank.unit,
      unitTitle: bank.unitTitle,
      questions: bank.questions.map(q => {
        const out = { ...q };
        out.marks = Number(out.marks);
        if (out.minKeywordsForFullMarks != null) out.minKeywordsForFullMarks = Number(out.minKeywordsForFullMarks);
        if (Number.isInteger(out.correctAnswer) || typeof out.correctAnswer === "boolean") {
          // leave as-is: index for mcq, boolean for truefalse
        } else if (out.correctAnswer != null) {
          out.correctAnswer = Number(out.correctAnswer);
        }
        return out;
      }),
    };
  }

  function setUnit(v) { bank.unit = v; markDirty(); }
  function setUnitTitle(v) { bank.unitTitle = v; markDirty(); }
  function setSearch(v) { searchTerm = v; renderList(); }
  function setBankId(v) { bankId = v; }
  function getBankId() { return bankId; }

  return {
    load, getBank, getBankId, setBankId, isDirty, clearDirty,
    addQuestion, duplicateQuestion, deleteQuestion, moveQuestion, appendQuestions,
    allProblems, nearDuplicates, toSaveable,
    setUnit, setUnitTitle, setSearch, setOnBankChanged,
    readDraft, discardDraft, render,
  };
})();
