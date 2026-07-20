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
    tabSwitchCount: 0
  };

  /** Called when the quiz tab is hidden (tab switch, minimize, app switch). */
  function recordTabSwitch() {
    if (state.submitted) return;
    state.tabSwitchCount += 1;
    return state.tabSwitchCount;
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
    // submitted/answers/tabSwitchCount must not leak in, even though the shipped
    // UI only ever calls init() once per page load (no "restart" button exists).
    state.submitted = false;
    state.answers = {};
    state.currentIndex = 0;
    state.tabSwitchCount = 0;

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

  function recordAnswer(questionId, rawAnswer) {
    state.answers[questionId] = rawAnswer;
    QuizStorage.saveProgress(state.config.quizId, state.student.rollNo, {
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

    const scoreResult = Scorer.scoreQuiz(state.quiz, state.answers);
    const meta = {
      studentName: state.student.name,
      rollNo: state.student.rollNo,
      quizTitle: state.config.quizTitle,
      quizId: state.config.quizId,
      submittedAt: new Date().toISOString(),
      autoSubmitted: isAutoSubmit,
      tabSwitchCount: state.tabSwitchCount
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
    submitQuiz, getState, recordTabSwitch
  };
})();
