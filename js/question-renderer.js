/**
 * question-renderer.js
 * ---------------------------------------------------------------------------
 * Renders a single question object into a DOM container based on its `type`,
 * and wires up change listeners that report the student's current answer
 * back to the quiz engine via `onAnswerChange(questionId, rawAnswer)`.
 * ---------------------------------------------------------------------------
 */

const QuestionRenderer = (() => {

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function questionHeader(question, index, total) {
    return el("div", { class: "q-header" }, [
      el("span", { class: "q-badge" }, `Q${index + 1} of ${total}`),
      el("span", { class: "q-meta" }, `${question.topic} · ${question.difficulty} · ${question.marks} mark${question.marks !== 1 ? "s" : ""}`),
    ]);
  }

  function render(question, index, total, existingAnswer, onAnswerChange) {
    const container = el("div", { class: "question-card", "data-qid": question.id });
    container.appendChild(questionHeader(question, index, total));
    container.appendChild(el("div", { class: "q-text" }, question.question));

    if (question.runnable) {
      container.appendChild(renderCodeEditor(question));
    } else if (question.codeSnippet) {
      container.appendChild(el("pre", { class: "q-code" }, question.codeSnippet));
    }

    switch (question.type) {
      case "mcq": renderMCQ(container, question, existingAnswer, onAnswerChange); break;
      case "truefalse": renderTrueFalse(container, question, existingAnswer, onAnswerChange); break;
      case "multiselect": renderMultiSelect(container, question, existingAnswer, onAnswerChange); break;
      case "fillblank":
      case "codeoutput": renderFillBlank(container, question, existingAnswer, onAnswerChange); break;
      case "debugging":
        question.acceptableAnswers
          ? renderFillBlank(container, question, existingAnswer, onAnswerChange)
          : renderTextArea(container, question, existingAnswer, onAnswerChange, "Explain the bug and the fix...");
        break;
      case "descriptive": renderTextArea(container, question, existingAnswer, onAnswerChange, "Write your answer here..."); break;
      case "scenario": renderTextArea(container, question, existingAnswer, onAnswerChange, "Analyze the scenario and respond..."); break;
      case "promptengineering": renderTextArea(container, question, existingAnswer, onAnswerChange, "Write your prompt here..."); break;
      default:
        container.appendChild(el("div", { class: "q-error" }, `Unsupported question type: ${question.type}`));
    }
    return container;
  }

  function renderMCQ(container, question, existingAnswer, onAnswerChange) {
    const group = el("div", { class: "q-options" });
    question.options.forEach((opt, i) => {
      const inputId = `${question.id}-opt${i}`;
      const input = el("input", { type: "radio", name: question.id, id: inputId, value: i });
      if (existingAnswer === i) input.checked = true;
      input.addEventListener("change", () => onAnswerChange(question.id, i));
      const label = el("label", { for: inputId, class: "q-option" }, [input, el("span", {}, opt)]);
      group.appendChild(label);
    });
    container.appendChild(group);
  }

  function renderTrueFalse(container, question, existingAnswer, onAnswerChange) {
    const group = el("div", { class: "q-options q-truefalse" });
    [["True", true], ["False", false]].forEach(([label, val]) => {
      const inputId = `${question.id}-${label}`;
      const input = el("input", { type: "radio", name: question.id, id: inputId, value: String(val) });
      if (existingAnswer === val) input.checked = true;
      input.addEventListener("change", () => onAnswerChange(question.id, val));
      group.appendChild(el("label", { for: inputId, class: "q-option" }, [input, el("span", {}, label)]));
    });
    container.appendChild(group);
  }

  function renderMultiSelect(container, question, existingAnswer, onAnswerChange) {
    const selected = new Set(existingAnswer || []);
    const group = el("div", { class: "q-options" });
    container.appendChild(el("div", { class: "q-hint" }, "Select ALL that apply."));
    question.options.forEach((opt, i) => {
      const inputId = `${question.id}-opt${i}`;
      const input = el("input", { type: "checkbox", id: inputId, value: i });
      if (selected.has(i)) input.checked = true;
      input.addEventListener("change", () => {
        input.checked ? selected.add(i) : selected.delete(i);
        onAnswerChange(question.id, Array.from(selected));
      });
      group.appendChild(el("label", { for: inputId, class: "q-option" }, [input, el("span", {}, opt)]));
    });
    container.appendChild(group);
  }

  /**
   * Interactive, editable Python code block backed by Pyodide (see
   * code-runner.js). Purely a self-check sandbox: running code never feeds
   * the graded answer, so a slow/blocked CDN never blocks quiz-taking.
   */
  function renderCodeEditor(question) {
    const wrap = el("div", { class: "q-code-editor-wrap" });
    const editor = el("textarea", { class: "q-code-editor", rows: "10", spellcheck: "false" });
    editor.value = question.codeSnippet;
    const runBtn = el("button", { class: "btn-secondary q-run-btn", type: "button" }, "▶ Run Code");
    const consoleEl = el("pre", { class: "q-code-console", style: "display:none;" }, "");

    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      consoleEl.style.display = "block";
      consoleEl.textContent = "";
      try {
        const result = await CodeRunner.run(editor.value);
        consoleEl.textContent = result.output;
        consoleEl.classList.toggle("q-code-console-error", !result.ok);
      } catch (e) {
        consoleEl.textContent = "Could not run Python in this browser: " + e.message;
        consoleEl.classList.add("q-code-console-error");
      }
      runBtn.disabled = false;
      runBtn.textContent = "▶ Run Code";
    });

    wrap.appendChild(editor);
    wrap.appendChild(el("div", { class: "btn-row", style: "margin-top:8px;" }, runBtn));
    wrap.appendChild(consoleEl);
    wrap.appendChild(el("div", { class: "q-hint" },
      "This is a sandbox to explore the code — running it doesn't submit an answer. Type your actual answer below."));
    return wrap;
  }

  function renderFillBlank(container, question, existingAnswer, onAnswerChange) {
    const input = el("input", { type: "text", class: "q-input-text", placeholder: "Type your answer..." });
    if (existingAnswer) input.value = existingAnswer;
    input.addEventListener("input", () => onAnswerChange(question.id, input.value));
    container.appendChild(input);
  }

  function renderTextArea(container, question, existingAnswer, onAnswerChange, placeholder) {
    const textarea = el("textarea", { class: "q-textarea", rows: "6", placeholder });
    if (existingAnswer) textarea.value = existingAnswer;
    textarea.addEventListener("input", () => onAnswerChange(question.id, textarea.value));
    container.appendChild(textarea);
    container.appendChild(el("div", { class: "q-hint" },
      "This answer will receive a suggested AI-free keyword-based score; your instructor will review it before finalizing."));
  }

  return { render };
})();
