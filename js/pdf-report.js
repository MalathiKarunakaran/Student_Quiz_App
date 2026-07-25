/**
 * pdf-report.js
 * ---------------------------------------------------------------------------
 * Generates a professional, printable PDF exam report entirely client-side
 * using jsPDF + jspdf-autotable, lazy-loaded from a CDN on first use (same
 * pattern as code-runner.js's Pyodide load — no build step, no server, no
 * API key; if the CDN is unreachable, PDF generation simply fails with a
 * clear error and CSV/JSON export still work as a fallback).
 *
 * Report contents (per the course's report requirements):
 *   student details, date/time, full question paper, student answers,
 *   correct answers, marks, topic-wise score, Bloom's-level analysis,
 *   time taken, and final grade.
 * ---------------------------------------------------------------------------
 */

const PDFReport = (() => {
  let libsPromise = null;

  function loadLibs_() {
    if (libsPromise) return libsPromise;
    libsPromise = new Promise((resolve, reject) => {
      const jspdfScript = document.createElement("script");
      jspdfScript.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      jspdfScript.onload = () => {
        const autoTableScript = document.createElement("script");
        autoTableScript.src = "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js";
        autoTableScript.onload = () => resolve(window.jspdf.jsPDF);
        autoTableScript.onerror = () => reject(new Error("Could not load the PDF table library (offline, or the CDN is blocked)."));
        document.head.appendChild(autoTableScript);
      };
      jspdfScript.onerror = () => reject(new Error("Could not load the PDF library (offline, or the CDN is blocked)."));
      document.head.appendChild(jspdfScript);
    });
    return libsPromise;
  }

  const DEFAULT_GRADE_SCALE = [
    { min: 90, grade: "A+" },
    { min: 80, grade: "A" },
    { min: 70, grade: "B" },
    { min: 60, grade: "C" },
    { min: 50, grade: "D" },
    { min: 0, grade: "F" }
  ];

  function computeGrade(percentage, scale) {
    const table = (scale && scale.length ? scale : DEFAULT_GRADE_SCALE).slice().sort((a, b) => b.min - a.min);
    const hit = table.find(row => percentage >= row.min);
    return hit ? hit.grade : "F";
  }

  function formatDuration(seconds) {
    if (seconds == null) return "N/A";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }

  /** Renders a student's raw answer (any question type) into readable text. */
  function formatStudentAnswer(question, rawAnswer) {
    if (rawAnswer === undefined || rawAnswer === null || rawAnswer === "") return "(not answered)";
    switch (question.type) {
      case "mcq":
        return question.options && question.options[rawAnswer] !== undefined ? question.options[rawAnswer] : String(rawAnswer);
      case "truefalse":
        return rawAnswer ? "True" : "False";
      case "multiselect":
        return (rawAnswer || []).map(i => question.options[i]).join(", ") || "(not answered)";
      default:
        return String(rawAnswer);
    }
  }

  /** Renders the correct/expected answer for a question into readable text. */
  function formatCorrectAnswer(question) {
    switch (question.type) {
      case "mcq":
        return question.options[question.correctAnswer];
      case "truefalse":
        return question.correctAnswer ? "True" : "False";
      case "multiselect":
        return (question.correctAnswers || []).map(i => question.options[i]).join(", ");
      case "fillblank":
      case "codeoutput":
        return (question.acceptableAnswers || []).join(" / ");
      case "debugging":
        return question.acceptableAnswers ? question.acceptableAnswers.join(" / ") : (question.modelAnswer || "(open-ended — see model answer)");
      default:
        return question.modelAnswer || "(open-ended — instructor-reviewed)";
    }
  }

  function groupAverage(perQuestion, keyFn) {
    const groups = new Map();
    perQuestion.forEach(r => {
      const key = keyFn(r) || "Unspecified";
      if (!groups.has(key)) groups.set(key, { earned: 0, max: 0, count: 0 });
      const g = groups.get(key);
      g.earned += r.earned; g.max += r.max; g.count += 1;
    });
    return Array.from(groups.entries()).map(([key, g]) => ({
      key, earned: Math.round(g.earned * 100) / 100, max: g.max, count: g.count,
      percentage: g.max === 0 ? 0 : Math.round((g.earned / g.max) * 1000) / 10
    }));
  }

  /**
   * Generates and triggers a download of the full PDF report.
   * quiz: array of generated question objects (same order as scoreResult.perQuestion)
   * answers: object keyed by question.id -> student's raw answer
   * config: the active quiz config (for passingPercentage / gradeScale)
   */
  async function generate(scoreResult, meta, quiz, answers, config) {
    const jsPDF = await loadLibs_();
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    let y = 50;

    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text(meta.quizTitle || "Quiz Report", margin, y);
    y += 18;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text("Examination Report — generated locally, no data leaves the browser", margin, y);
    y += 24;

    const grade = computeGrade(scoreResult.percentage, config && config.gradeScale);
    const passed = scoreResult.percentage >= ((config && config.passingPercentage) || 50);
    const submittedDate = new Date(meta.submittedAt);

    doc.autoTable({
      startY: y,
      theme: "grid",
      styles: { fontSize: 9, cellPadding: 5 },
      head: [["Student Details", ""]],
      body: [
        ["Name", meta.studentName],
        ["Roll Number", meta.rollNo],
        ["Quiz ID", meta.quizId],
        ["Date / Time Submitted", submittedDate.toLocaleString()],
        ["Time Taken", formatDuration(meta.timeTakenSeconds)],
        ["Auto-Submitted", meta.autoSubmitted ? `Yes (${meta.autoSubmitReason || "time expired"})` : "No"],
        ["Total Marks", `${scoreResult.totalEarned} / ${scoreResult.totalMax}`],
        ["Percentage", `${scoreResult.percentage}%`],
        ["Final Grade", grade],
        ["Result", passed ? "PASS" : "FAIL"],
        ["Integrity Violations Logged", String(meta.violationCount || 0)]
      ],
      margin: { left: margin, right: margin }
    });
    y = doc.lastAutoTable.finalY + 20;

    const topicStats = groupAverage(scoreResult.perQuestion, r => r.topic);
    doc.autoTable({
      startY: y, theme: "striped", styles: { fontSize: 9, cellPadding: 5 },
      head: [["Topic-Wise Performance", "Marks", "Percentage"]],
      body: topicStats.map(t => [t.key, `${t.earned} / ${t.max}`, `${t.percentage}%`]),
      margin: { left: margin, right: margin }
    });
    y = doc.lastAutoTable.finalY + 20;

    const bloomStats = groupAverage(scoreResult.perQuestion, r => r.bloom);
    doc.autoTable({
      startY: y, theme: "striped", styles: { fontSize: 9, cellPadding: 5 },
      head: [["Bloom's Taxonomy Level", "Marks", "Percentage"]],
      body: bloomStats.map(b => [b.key, `${b.earned} / ${b.max}`, `${b.percentage}%`]),
      margin: { left: margin, right: margin }
    });
    y = doc.lastAutoTable.finalY + 20;

    doc.addPage();
    y = 50;
    doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("Question Paper, Answers & Marks", margin, y);
    y += 10;

    const rows = quiz.map((q, i) => {
      const r = scoreResult.perQuestion[i];
      return [
        String(i + 1),
        q.question,
        formatStudentAnswer(q, answers[q.id]),
        formatCorrectAnswer(q),
        `${r.earned} / ${r.max}`,
        r.correct === true ? "Correct" : r.correct === false ? "Incorrect" : "Pending Review"
      ];
    });
    doc.autoTable({
      startY: y + 10,
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 5, overflow: "linebreak" },
      headStyles: { fillColor: [31, 56, 100] },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 170 },
        2: { cellWidth: 100 },
        3: { cellWidth: 100 },
        4: { cellWidth: 45 },
        5: { cellWidth: 60 }
      },
      head: [["#", "Question", "Student Answer", "Correct Answer", "Marks", "Status"]],
      body: rows,
      margin: { left: margin, right: margin }
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin - 60, doc.internal.pageSize.getHeight() - 20);
    }

    doc.save(`${meta.quizId}_${meta.rollNo}_report.pdf`);
  }

  return { generate, computeGrade };
})();
