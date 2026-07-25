/**
 * quiz-engine.js
 * ---------------------------------------------------------------------------
 * The core state machine driving the student quiz-taking experience:
 *   1. Resolve config (URL param or file) + load question bank
 *   2. Filter questions per config.filters
 *   3. Select N questions (seeded or true-random) + optionally shuffle options
 *   4. Render questions one at a time with navigation, progress bar, and timer
 *   5. Persist progress to localStorage as the student answers
 *   6. On submit (manual or auto via timer expiry): score, show results,
 *      offer CSV/JSON download
 * ---------------------------------------------------------------------------
 */

const QuizEngine = (() => {
  let state = {
    config: null,
    questionBank: [],
    quiz: [],           // the generated (filtered + selected + option-shuffled) question list
    answers: {},         // questionId -> raw answer
    currentIndex: 0,
    student: { name: "", rollNo: "" },
    timer: null,
    submitted: false,
    violations: []   // { type: 'tabswitch'|'windowblur'|'fullscreenexit', at: ISOString }
  };

  /**
   * Called by IntegrityGuard whenever it detects a tab-switch, window-blur, or
   * fullscreen-exit event. Applies the teacher-configured violation policy:
   *   'warn'             — just log it, never auto-submit
   *   'autoSubmitAfterN' — auto-submit once total violations reach maxViolations
   *   'immediate'        — auto-submit on the very first violation
   * Returns { count, type, triggeredSubmit, submitResult } so the caller can
   * update the UI and, if triggeredSubmit, show the results screen.
   */
  function recordViolation(type) {
    if (state.submitted) return null;
    state.violations.push({ type, at: new Date().toISOString() });
    const count = state.violations.length;

    const policy = (state.config && state.config.violationPolicy) || { mode: "warn" };
    let triggeredSubmit = false;
    if (policy.mode === "immediate") {
      triggeredSubmit = true;
    } else if (policy.mode === "autoSubmitAfterN" && count >= (policy.maxViolations || 3)) {
      triggeredSubmit = true;
    }

    let submitResult = null;
    if (triggeredSubmit) {
      submitResult = submitQuiz(true);
      if (submitResult) submitResult.meta.autoSubmitReason = `violation-policy (${type})`;
    }
    return { count, type, triggeredSubmit, submitResult };
  }

  function getViolationBreakdown() {
    const breakdown = { tabswitch: 0, windowblur: 0, fullscreenexit: 0 };
    state.violations.forEach(v => { breakdown[v.type] = (breakdown[v.type] || 0) + 1; });
    return breakdown;
  }

  function filterQuestions(bank, filters) {
    return bank.filter(q => {
      if (filters.unit && q.unit !== filters.unit) return false;
      if (filters.topics && !filters.topics.includes("all") && !filters.topics.includes(q.topic)) return false;
      if (filters.difficulty && !filters.difficulty.includes(q.difficulty)) return false;
      if (filters.bloomLevels && !filters.bloomLevels.includes(q.bloom)) return false;
      if (filters.questionTypes && !filters.questionTypes.includes(q.type)) return false;
      return true;
    });
  }

  async function init(studentName, rollNo) {
    // Always starts a genuinely fresh attempt in memory — any previous attempt's
    // submitted/answers/violations must not leak in, even though the shipped
    // UI only ever calls init() once per page load (no "restart" button exists).
    state.submitted = false;
    state.answers = {};
    state.currentIndex = 0;
    state.violations = [];

    state.student = { name: studentName, rollNo };
    state.config = await DataLoader.resolveConfig();
    state.questionBank = await DataLoader.loadQuestionBank(state.config.questionBankFile);

    const filtered = filterQuestions(state.questionBank, state.config.filters);
    if (filtered.length === 0) {
      throw new Error("No questions match the configured filters. Check the teacher configuration.");
    }

    const seedString = state.config.randomizationMode === "seeded" ? rollNo : null;
    const randFn = Randomizer.getRandFn(state.config.randomizationMode, seedString);

    let selected = Randomizer.selectQuestions(filtered, state.config.numQuestions, randFn);
    if (state.config.shuffleOptions) {
      selected = selected.map(q => Randomizer.shuffleOptions(q, randFn));
    }
    state.quiz = selected;

    // Restore any in-progress attempt for this student+quiz (same browser/device).
    const saved = QuizStorage.loadProgress(state.config.quizId, rollNo);
    if (saved) {
      state.answers = saved.answers || {};
      state.currentIndex = saved.currentIndex || 0;
    }

    const storageKey = `csa65timer::${state.config.quizId}::${rollNo}`;
    state.timer = new QuizTimer(
      state.config.timeLimitMinutes,
      storageKey,
      (secondsRemaining) => onTick && onTick(secondsRemaining),
      () => {
        const result = submitQuiz(true);
        if (result && onAutoSubmit) onAutoSubmit(result);
      }
    );

    return state;
  }

  let onTick = null;
  let onAutoSubmit = null;
  function setTickHandler(fn) { onTick = fn; }
  function setAutoSubmitHandler(fn) { onAutoSubmit = fn; }

  function getCurrentQuestion() {
    return state.quiz[state.currentIndex];
  }

  /** Returns whether the answer was actually persisted to localStorage (the in-memory
   *  state.answers is always updated regardless, so nothing is lost for the rest of
   *  this session — the return value only reflects survival across a refresh/close). */
  function recordAnswer(questionId, rawAnswer) {
    state.answers[questionId] = rawAnswer;
    return QuizStorage.saveProgress(state.config.quizId, state.student.rollNo, {
      answers: state.answers, currentIndex: state.currentIndex
    });
  }

  function goToQuestion(index) {
    if (index < 0 || index >= state.quiz.length) return false;
    state.currentIndex = index;
    QuizStorage.saveProgress(state.config.quizId, state.student.rollNo, {
      answers: state.answers, currentIndex: state.currentIndex
    });
    return true;
  }

  function nextQuestion() { return goToQuestion(state.currentIndex + 1); }
  function prevQuestion() { return goToQuestion(state.currentIndex - 1); }

  function getProgress() {
    const answered = state.quiz.filter(q => state.answers[q.id] !== undefined).length;
    return { answered, total: state.quiz.length, percent: Math.round((answered / state.quiz.length) * 100) };
  }

  function submitQuiz(isAutoSubmit = false) {
    if (state.submitted) return null;
    state.submitted = true;
    if (state.timer) state.timer.stop();

    const scoreResult = Scorer.scoreQuiz(state.quiz, state.answers, state.config.negativeMarking);
    const timeLimitSeconds = (state.config.timeLimitMinutes || 0) * 60;
    const elapsedSeconds = state.timer
      ? Math.round((Date.now() - state.timer.startTime) / 1000)
      : null;
    const meta = {
      studentName: state.student.name,
      rollNo: state.student.rollNo,
      quizTitle: state.config.quizTitle,
      quizId: state.config.quizId,
      submittedAt: new Date().toISOString(),
      autoSubmitted: isAutoSubmit,
      violationCount: state.violations.length,
      violationBreakdown: getViolationBreakdown(),
      timeTakenSeconds: elapsedSeconds === null ? null : Math.min(elapsedSeconds, timeLimitSeconds || elapsedSeconds),
      timeLimitSeconds: timeLimitSeconds || null
    };
    QuizStorage.saveResult(state.config.quizId, state.student.rollNo, { scoreResult, meta });
    QuizStorage.clearProgress(state.config.quizId, state.student.rollNo);
    if (state.timer) state.timer.clearPersistence();

    return { scoreResult, meta };
  }

  function getState() { return state; }

  return {
    init, setTickHandler, setAutoSubmitHandler, getCurrentQuestion, recordAnswer,
    goToQuestion, nextQuestion, prevQuestion, getProgress,
    submitQuiz, getState, recordViolation, getViolationBreakdown
  };
})();
