/**
 * storage.js
 * ---------------------------------------------------------------------------
 * localStorage helpers for persisting in-progress quiz state (answers given
 * so far + current question index) so a student who accidentally refreshes
 * or closes the tab can resume exactly where they left off, on the SAME
 * browser/device. This is client-only persistence — there is no server, so
 * switching devices will NOT carry progress over (see README "Security &
 * Limitations").
 * ---------------------------------------------------------------------------
 */

const QuizStorage = (() => {

  function key(quizId, rollNo) {
    return `csa65quiz::${quizId}::${rollNo}`;
  }

  function saveProgress(quizId, rollNo, state) {
    try {
      localStorage.setItem(key(quizId, rollNo), JSON.stringify(state));
    } catch (e) {
      console.warn("QuizStorage: could not save progress (localStorage unavailable/full)", e);
    }
  }

  function loadProgress(quizId, rollNo) {
    try {
      const raw = localStorage.getItem(key(quizId, rollNo));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn("QuizStorage: could not load progress", e);
      return null;
    }
  }

  function clearProgress(quizId, rollNo) {
    localStorage.removeItem(key(quizId, rollNo));
  }

  /** Saves a completed attempt's result summary (for the student's own record / re-download). */
  function saveResult(quizId, rollNo, resultSummary) {
    try {
      localStorage.setItem(`csa65result::${quizId}::${rollNo}`, JSON.stringify(resultSummary));
    } catch (e) {
      console.warn("QuizStorage: could not save result", e);
    }
  }

  function loadResult(quizId, rollNo) {
    try {
      const raw = localStorage.getItem(`csa65result::${quizId}::${rollNo}`);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  return { saveProgress, loadProgress, clearProgress, saveResult, loadResult };
})();
