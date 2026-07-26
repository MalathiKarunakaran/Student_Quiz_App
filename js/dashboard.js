/**
 * dashboard.js
 * ---------------------------------------------------------------------------
 * Drives dashboard.html: the whole page is gated behind Firebase sign-in
 * (js/auth-guard.js) — no submission data is fetched or rendered until
 * AuthGuard confirms a signed-in user (Firestore security rules would deny
 * the reads anyway; this just avoids showing an empty/error table first).
 * ---------------------------------------------------------------------------
 */

const Dashboard = (() => {
  let currentSubmissions = [];
  let expandedId = null;

  function init() {
    const gate = document.getElementById('dashLoginGate');
    const content = document.getElementById('dashContent');

    if (!FirebaseApp.isConfigured()) {
      gate.innerHTML = '<div class="error-box">Firebase is not configured yet — see docs/firebase-setup.md.</div>';
      return;
    }

    AuthGuard.onAuthChange(user => {
      if (user) {
        gate.innerHTML = `<div class="footnote">Signed in as ${user.email}. <a href="#" onclick="AuthGuard.signOut(); return false;">Sign out</a></div>`;
        content.style.display = 'block';
        applyFilters();
      } else {
        content.style.display = 'none';
        AuthGuard.renderLoginForm(gate, { title: 'Teacher Sign-In', onSignedIn: () => location.reload() });
      }
    });
  }

  function readFilters() {
    const filters = {};
    const rollNo = document.getElementById('filterRollNo').value.trim();
    const unit = document.getElementById('filterUnit').value;
    const topic = document.getElementById('filterTopic').value.trim();
    const fromDate = document.getElementById('filterFromDate').value;
    const toDate = document.getElementById('filterToDate').value;
    if (rollNo) filters.rollNo = rollNo;
    if (unit) filters.unit = unit;
    if (topic) filters.topic = topic;
    if (fromDate) filters.fromDate = fromDate;
    if (toDate) filters.toDate = toDate + 'T23:59:59';
    return filters;
  }

  async function applyFilters() {
    const errorEl = document.getElementById('dashError');
    const summaryEl = document.getElementById('dashSummary');
    errorEl.innerHTML = '';
    document.getElementById('dashTableWrap').innerHTML = '<div class="empty-state">Loading…</div>';

    try {
      currentSubmissions = await FirestoreClient.querySubmissions(readFilters());
      expandedId = null;
      summaryEl.textContent = `${currentSubmissions.length} submission${currentSubmissions.length !== 1 ? 's' : ''} found.`;
      renderTable();
    } catch (e) {
      // A brand-new compound filter combination often needs a Firestore
      // composite index the first time it's used — surface that link
      // directly rather than a generic failure (see docs/firebase-setup.md).
      errorEl.innerHTML = `<div class="error-box">Could not load submissions: ${e.message}</div>`;
      document.getElementById('dashTableWrap').innerHTML = '';
    }
  }

  function clearFilters() {
    document.getElementById('filterRollNo').value = '';
    document.getElementById('filterUnit').value = '';
    document.getElementById('filterTopic').value = '';
    document.getElementById('filterFromDate').value = '';
    document.getElementById('filterToDate').value = '';
    applyFilters();
  }

  function toggleExpand(id) {
    expandedId = expandedId === id ? null : id;
    renderTable();
  }

  /** Reuses the same submission-doc shape as Scorer.scoreQuiz()'s output — field names match 1:1. */
  function toMeta(submission) {
    return {
      studentName: submission.student.name,
      rollNo: submission.student.rollNo,
      quizTitle: submission.quizTitle,
      quizId: submission.quizId,
      submittedAt: submission.submittedAt,
      autoSubmitted: submission.autoSubmitted,
      autoSubmitReason: submission.autoSubmitReason,
      timeTakenSeconds: submission.timeTakenSeconds,
      violationCount: submission.violationCount
    };
  }

  function downloadRowCSV(id) {
    const submission = currentSubmissions.find(s => s.id === id);
    if (!submission) return;
    Exporter.exportStudentResultCSV(submission, toMeta(submission));
  }

  async function downloadRowPDF(id) {
    const submission = currentSubmissions.find(s => s.id === id);
    if (!submission) return;
    try {
      await PDFReport.generate(submission, toMeta(submission), submission.questionSnapshot, submission.answers, { passingPercentage: submission.passingPercentage });
    } catch (e) {
      alert('Could not generate the PDF report: ' + e.message);
    }
  }

  function exportFilteredCSV() {
    if (currentSubmissions.length === 0) {
      alert('No submissions to export — adjust your filters first.');
      return;
    }
    Exporter.exportSubmissionsCSV(currentSubmissions);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderDetail(submission) {
    const rows = submission.perQuestion.map((r, i) => {
      const q = submission.questionSnapshot[i];
      let statusHtml;
      if (r.correct === true) statusHtml = '<span class="badge-correct">✓ Correct</span>';
      else if (r.correct === false) statusHtml = '<span class="badge-incorrect">✗ Incorrect</span>';
      else statusHtml = '<span class="badge-review">Pending Review</span>';

      const studentAnswer = escapeHtml(PDFReport.formatStudentAnswer(q, submission.answers[q.id]));
      const correctAnswer = escapeHtml(PDFReport.formatCorrectAnswer(q));

      let evalHtml = '';
      if (r.needsReview && (r.keywordsFound || r.keywordsMissing)) {
        evalHtml = `
          <div class="explanation-box">
            ${r.keywordsFound && r.keywordsFound.length ? `<div><b>Matched keywords:</b> ${escapeHtml(r.keywordsFound.join(', '))}</div>` : ''}
            ${r.keywordsMissing && r.keywordsMissing.length ? `<div><b>Missing keywords:</b> ${escapeHtml(r.keywordsMissing.join(', '))}</div>` : ''}
            ${r.feedback ? `<div><b>Feedback:</b> ${escapeHtml(r.feedback)}</div>` : ''}
            ${r.suggestedImprovement ? `<div><b>Suggested improvement:</b> ${escapeHtml(r.suggestedImprovement)}</div>` : ''}
          </div>`;
      }

      return `
        <div class="result-row" style="flex-direction:column; align-items:stretch; gap:4px;">
          <div style="display:flex; justify-content:space-between;">
            <span>Q${i + 1}. ${escapeHtml(q.topic)} (${escapeHtml(q.type)})</span>
            <span>${statusHtml} — ${r.earned}/${r.max}</span>
          </div>
          <div style="font-size:12.5px; color:var(--graphite);">${escapeHtml(q.question)}</div>
          <div style="font-size:12.5px;"><b>Student answer:</b> ${studentAnswer}</div>
          <div style="font-size:12.5px;"><b>Correct/expected:</b> ${correctAnswer}</div>
          ${evalHtml}
        </div>`;
    }).join('');

    return `
      <div class="card" style="margin:0 0 18px; background:color-mix(in srgb, var(--signal) 4%, var(--surface));">
        <div class="btn-row" style="margin-top:0; margin-bottom:14px;">
          <button class="btn-secondary" onclick="Dashboard.downloadRowCSV('${submission.id}')">Download CSV</button>
          <button class="btn-secondary" onclick="Dashboard.downloadRowPDF('${submission.id}')">Download PDF</button>
        </div>
        ${rows}
      </div>`;
  }

  function renderTable() {
    const wrap = document.getElementById('dashTableWrap');
    if (currentSubmissions.length === 0) {
      wrap.innerHTML = '<div class="empty-state">No submissions match these filters.</div>';
      return;
    }

    const rowsHtml = currentSubmissions.map(s => {
      const submittedLabel = s.submittedAt ? new Date(s.submittedAt).toLocaleString() : 'N/A';
      const reviewLabel = s.reviewStatus === 'pending' ? 'Pending' : s.reviewStatus;
      const rowHtml = `
        <tr class="dash-row" onclick="Dashboard.toggleExpand('${s.id}')">
          <td>${escapeHtml(s.student.rollNo)}</td>
          <td>${escapeHtml(s.student.name)}</td>
          <td>${escapeHtml(s.quizTitle)}</td>
          <td>${escapeHtml(s.unit)}</td>
          <td>${s.totalEarned}/${s.totalMax} (${s.percentage}%)</td>
          <td>${s.violationCount || 0}</td>
          <td>${submittedLabel}</td>
          <td>${escapeHtml(reviewLabel)}</td>
        </tr>`;
      const detailHtml = expandedId === s.id
        ? `<tr><td colspan="8" style="padding:14px 0 0;">${renderDetail(s)}</td></tr>`
        : '';
      return rowHtml + detailHtml;
    }).join('');

    wrap.innerHTML = `
      <table class="dash-table">
        <thead>
          <tr><th>Roll No</th><th>Name</th><th>Quiz</th><th>Unit</th><th>Score</th><th>Violations</th><th>Submitted</th><th>Review</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
  }

  return { init, applyFilters, clearFilters, toggleExpand, downloadRowCSV, downloadRowPDF, exportFilteredCSV };
})();
