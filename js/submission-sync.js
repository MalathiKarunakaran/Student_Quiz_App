/**
 * submission-sync.js
 * ---------------------------------------------------------------------------
 * Writes the completed quiz submission to Firestore (js/firestore-client.js),
 * on top of the existing, unchanged localStorage save in js/storage.js — that
 * stays as the resume/offline fallback exactly as before. There is no service
 * worker in this static app, so a failed write can only retry on a later page
 * load, not truly in the background; failed docs are kept in localStorage
 * under a `csa65pendingsync::` key and flushed by retryPending(), which
 * index.html/student.html call once on load.
 * ---------------------------------------------------------------------------
 */

const SubmissionSync = (() => {
  const PENDING_PREFIX = "csa65pendingsync::";

  function pendingKey(quizId, rollNo) {
    return `${PENDING_PREFIX}${quizId}::${rollNo}`;
  }

  function buildDoc({ config, quiz, answers, scoreResult, meta }) {
    const passingPercentage = config.passingPercentage || 50;
    return {
      quizId: meta.quizId,
      unit: (config.filters && config.filters.unit) || "",
      quizTitle: meta.quizTitle,
      student: { name: meta.studentName, rollNo: meta.rollNo },
      // Flat, deduped list of topics covered by this attempt — lets the
      // dashboard filter submissions by topic via a Firestore array-contains
      // query, since a submission spans many topics (one per question), not one.
      topics: [...new Set(quiz.map(q => q.topic))],
      questionSnapshot: quiz,
      answers,
      perQuestion: scoreResult.perQuestion,
      totalEarned: scoreResult.totalEarned,
      totalMax: scoreResult.totalMax,
      percentage: scoreResult.percentage,
      passingPercentage,
      passed: scoreResult.percentage >= passingPercentage,
      timeTakenSeconds: meta.timeTakenSeconds,
      timeLimitSeconds: meta.timeLimitSeconds,
      autoSubmitted: meta.autoSubmitted,
      autoSubmitReason: meta.autoSubmitReason || null,
      violations: meta.violations || [],
      violationCount: meta.violationCount,
      violationBreakdown: meta.violationBreakdown,
      reviewStatus: "pending",
      reviewedBy: null,
    };
  }

  /** Returns { synced: boolean, reason? } — never throws, so it's always safe to await at submit time. */
  async function sync(payload) {
    if (!FirebaseApp.isConfigured()) return { synced: false, reason: "Firebase not configured yet" };

    const doc = buildDoc(payload);
    const key = pendingKey(doc.quizId, doc.student.rollNo);
    try {
      await FirestoreClient.saveSubmission(doc);
      localStorage.removeItem(key);
      return { synced: true };
    } catch (e) {
      // ALREADY_EXISTS just means an earlier attempt for this exact quiz+student
      // already reached Firestore — that's success, not a failure to retry.
      if (String(e.code) === "already-exists" || /already exists/i.test(e.message || "")) {
        localStorage.removeItem(key);
        return { synced: true };
      }
      try { localStorage.setItem(key, JSON.stringify(doc)); } catch (_e) { /* localStorage full/unavailable */ }
      return { synced: false, reason: e.message };
    }
  }

  /** Call once on page load to flush any submissions that failed to sync last time. */
  async function retryPending() {
    if (!FirebaseApp.isConfigured()) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PENDING_PREFIX)) keys.push(k);
    }
    for (const key of keys) {
      try {
        const doc = JSON.parse(localStorage.getItem(key));
        await FirestoreClient.saveSubmission(doc);
        localStorage.removeItem(key);
      } catch (e) {
        // Still pending (or a genuinely new failure) — leave it for the next load.
      }
    }
  }

  return { sync, retryPending };
})();
