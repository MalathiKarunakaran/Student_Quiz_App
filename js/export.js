/**
 * export.js
 * ---------------------------------------------------------------------------
 * Generates downloadable CSV files for:
 *   - a single student's detailed result (per-question breakdown)
 *   - (on the teacher side) a combined class report, if the instructor
 *     collects each student's downloaded JSON result and re-imports them
 *     (see README "Teacher Workflow" — there is no shared server, so class
 *     aggregation happens by collecting individual downloads).
 * ---------------------------------------------------------------------------
 */

const Exporter = (() => {

  function downloadFile(filename, content, mimeType = "text/csv") {
    const blob = new Blob([content], { type: mimeType + ";charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const str = String(value == null ? "" : value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  /**
   * Builds and downloads a CSV of one student's full result.
   * scoreResult: output of Scorer.scoreQuiz()
   * meta: { studentName, rollNo, quizTitle, quizId, submittedAt }
   */
  function exportStudentResultCSV(scoreResult, meta) {
    const header = ["Question ID", "Topic", "Type", "Marks Earned", "Max Marks", "Correct", "Needs Review"];
    const rows = scoreResult.perQuestion.map(r => [
      r.questionId, r.topic, r.type, r.earned, r.max,
      r.correct === null ? "N/A (open-ended)" : (r.correct ? "Yes" : "No"),
      r.needsReview ? "Yes" : "No"
    ]);
    const summary = [
      [], ["Student", meta.studentName], ["Roll No", meta.rollNo], ["Quiz", meta.quizTitle],
      ["Submitted At", meta.submittedAt], ["Total Marks", `${scoreResult.totalEarned} / ${scoreResult.totalMax}`],
      ["Percentage", `${scoreResult.percentage}%`], ["Time Taken (seconds)", meta.timeTakenSeconds ?? "N/A"],
      ["Integrity Violations", meta.violationCount || 0], ["Auto-Submitted", meta.autoSubmitted ? "Yes" : "No"]
    ];
    const csvLines = [header.map(csvEscape).join(",")]
      .concat(rows.map(r => r.map(csvEscape).join(",")))
      .concat(summary.map(r => r.map(csvEscape).join(",")));
    downloadFile(`${meta.quizId}_${meta.rollNo}_result.csv`, csvLines.join("\n"));
  }

  /**
   * Also exports the raw result as JSON — useful for the instructor to
   * re-import multiple students' JSON results into a single class report
   * (a small script/spreadsheet can merge these; no server needed).
   */
  function exportStudentResultJSON(scoreResult, meta) {
    const payload = Object.assign({ meta }, scoreResult);
    downloadFile(`${meta.quizId}_${meta.rollNo}_result.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  /**
   * Bulk CSV export for the teacher dashboard — one row per submission
   * (unlike exportStudentResultCSV's one-row-per-question detail for a
   * single student). submissions: the array js/firestore-client.js
   * querySubmissions() returns.
   */
  function exportSubmissionsCSV(submissions) {
    const header = [
      "Roll No", "Name", "Quiz ID", "Quiz Title", "Unit", "Marks Earned", "Max Marks",
      "Percentage", "Passed", "Time Taken (seconds)", "Auto-Submitted", "Violation Count",
      "Submitted At", "Review Status"
    ];
    const rows = submissions.map(s => [
      s.student.rollNo, s.student.name, s.quizId, s.quizTitle, s.unit,
      s.totalEarned, s.totalMax, s.percentage, s.passed ? "Yes" : "No",
      s.timeTakenSeconds ?? "N/A", s.autoSubmitted ? "Yes" : "No", s.violationCount || 0,
      s.submittedAt || "N/A", s.reviewStatus
    ]);
    const csvLines = [header.map(csvEscape).join(",")].concat(rows.map(r => r.map(csvEscape).join(",")));
    downloadFile(`submissions_export_${Date.now()}.csv`, csvLines.join("\n"));
  }

  return { downloadFile, exportStudentResultCSV, exportStudentResultJSON, exportSubmissionsCSV };
})();
