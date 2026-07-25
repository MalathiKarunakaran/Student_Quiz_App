/**
 * scorer.js
 * ---------------------------------------------------------------------------
 * Scoring logic for every supported question type.
 *
 * OBJECTIVE types (auto-scored with full confidence):
 *   mcq, truefalse, multiselect, fillblank, codeoutput, debugging (when the
 *   debugging question has acceptableAnswers — otherwise treated as open-ended)
 *
 * OPEN-ENDED types (keyword-based SUGGESTED score, flagged for instructor
 * review — this app has NO server-side or AI grading, per the "no backend,
 * no exposed API keys" requirement; see README "Future AI Integration"):
 *   descriptive, scenario, promptengineering, debugging (when open-ended)
 *
 * Every scoring function returns:
 *   { earned: number, max: number, correct: boolean|null, needsReview: boolean }
 * `correct` is null for open-ended types (can't be definitively judged client-side).
 * ---------------------------------------------------------------------------
 */

const Scorer = (() => {

  function scoreMCQ(question, studentAnswerIndex) {
    const correct = studentAnswerIndex === question.correctAnswer;
    return { earned: correct ? question.marks : 0, max: question.marks, correct, needsReview: false };
  }

  function scoreTrueFalse(question, studentAnswerBool) {
    const correct = studentAnswerBool === question.correctAnswer;
    return { earned: correct ? question.marks : 0, max: question.marks, correct, needsReview: false };
  }

  /**
   * Multi-select: proportional credit.
   * earned = max * max(0, correctSelections - incorrectSelections) / totalCorrectOptions
   * Floored at 0 so guessing everything doesn't game the score.
   */
  function scoreMultiSelect(question, studentAnswerIndices) {
    const correctSet = new Set(question.correctAnswers);
    const studentSet = new Set(studentAnswerIndices || []);
    let correctHits = 0, incorrectHits = 0;
    studentSet.forEach(idx => correctSet.has(idx) ? correctHits++ : incorrectHits++);
    const rawScore = Math.max(0, correctHits - incorrectHits) / correctSet.size;
    const earned = Math.round(rawScore * question.marks * 100) / 100;
    const isFullyCorrect = studentSet.size === correctSet.size &&
      [...studentSet].every(idx => correctSet.has(idx));
    return { earned, max: question.marks, correct: isFullyCorrect, needsReview: false };
  }

  /**
   * Fill-in-the-blank: case-insensitive (unless caseSensitive:true) trimmed
   * match against any of the acceptableAnswers.
   */
  function scoreFillBlank(question, studentAnswerText) {
    const student = (studentAnswerText || "").trim();
    const compare = (a, b) => question.caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
    const correct = (question.acceptableAnswers || []).some(ans => compare(student, ans.trim()));
    return { earned: correct ? question.marks : 0, max: question.marks, correct, needsReview: false };
  }

  /** Code output questions behave like fill-blank (compare expected output text). */
  function scoreCodeOutput(question, studentAnswerText) {
    return scoreFillBlank(question, studentAnswerText);
  }

  /**
   * Keyword-based SUGGESTED scoring for open-ended answers (descriptive,
   * scenario, prompt engineering, and debugging-without-acceptableAnswers).
   * Counts how many of the question's keywords appear (case-insensitive,
   * substring match) in the student's free-text answer, then scales marks
   * proportionally against `minKeywordsForFullMarks`.
   *
   * This is NOT true semantic grading — it is a fast first-pass suggestion.
   * needsReview is always true for these types; the instructor should read
   * the actual answer before finalizing the mark (see README "Security &
   * Limitations").
   */
  function scoreOpenEnded(question, studentAnswerText) {
    const text = (studentAnswerText || "").toLowerCase();
    const keywords = question.keywords || [];
    const found = keywords.filter(k => text.includes(k.toLowerCase()));
    const target = question.minKeywordsForFullMarks || Math.max(1, keywords.length);
    const ratio = keywords.length === 0 ? 0 : Math.min(1, found.length / target);
    const earned = Math.round(ratio * question.marks * 100) / 100;
    return {
      earned, max: question.marks, correct: null, needsReview: true,
      keywordsFound: found, keywordsMissing: keywords.filter(k => !found.includes(k))
    };
  }

  /**
   * Master dispatch: scores a single question given the student's raw answer
   * (shape of `studentAnswer` depends on question.type — see README schema).
   */
  function scoreQuestion(question, studentAnswer) {
    switch (question.type) {
      case "mcq": return scoreMCQ(question, studentAnswer);
      case "truefalse": return scoreTrueFalse(question, studentAnswer);
      case "multiselect": return scoreMultiSelect(question, studentAnswer);
      case "fillblank": return scoreFillBlank(question, studentAnswer);
      case "codeoutput": return scoreCodeOutput(question, studentAnswer);
      case "debugging":
        return question.acceptableAnswers
          ? scoreFillBlank(question, studentAnswer)
          : scoreOpenEnded(question, studentAnswer);
      case "descriptive":
      case "scenario":
      case "promptengineering":
        return scoreOpenEnded(question, studentAnswer);
      default:
        return { earned: 0, max: question.marks || 0, correct: null, needsReview: true };
    }
  }

  /**
   * Negative marking: deducts `penaltyFraction` of a question's marks for a
   * WRONG objective answer (correct === false). Deliberately excluded:
   *   - multiselect: already uses proportional partial credit (scoreMultiSelect
   *     above), so stacking a flat penalty on top would double-punish a
   *     partially-correct selection.
   *   - open-ended types (correct === null): never definitively "wrong",
   *     so a client-side keyword-match score should never be penalized.
   * The deduction can push a single question's contribution negative — that's
   * intentional (standard negative-marking behavior) — but the QUIZ TOTAL is
   * floored at 0 in scoreQuiz() below, never a negative overall score.
   */
  function applyNegativeMarking(result, question, negativeMarking) {
    if (!negativeMarking || !negativeMarking.enabled) return result;
    if (result.correct !== false) return result;
    if (question.type === "multiselect") return result;
    const penaltyFraction = negativeMarking.penaltyFraction != null ? negativeMarking.penaltyFraction : 0.25;
    const penalized = Math.round((result.earned - question.marks * penaltyFraction) * 100) / 100;
    return Object.assign({}, result, { earned: penalized, negativeMarkingApplied: true });
  }

  /**
   * Scores an entire quiz attempt.
   * quiz: array of question objects (the actual generated quiz)
   * answers: object keyed by question.id -> student's raw answer
   * negativeMarking (optional): { enabled: boolean, penaltyFraction: number }
   * Returns: { totalEarned, totalMax, percentage, perQuestion: [...], anyNeedsReview }
   */
  function scoreQuiz(quiz, answers, negativeMarking) {
    const perQuestion = quiz.map(q => {
      let result = scoreQuestion(q, answers[q.id]);
      result = applyNegativeMarking(result, q, negativeMarking);
      return Object.assign(
        { questionId: q.id, topic: q.topic, type: q.type, bloom: q.bloom, marks: q.marks, question: q.question },
        result
      );
    });
    const rawTotal = Math.round(perQuestion.reduce((s, r) => s + r.earned, 0) * 100) / 100;
    const totalEarned = Math.max(0, rawTotal);
    const totalMax = perQuestion.reduce((s, r) => s + r.max, 0);
    const percentage = totalMax === 0 ? 0 : Math.round((totalEarned / totalMax) * 1000) / 10;
    const anyNeedsReview = perQuestion.some(r => r.needsReview);
    return { totalEarned, totalMax, percentage, perQuestion, anyNeedsReview };
  }

  return { scoreQuestion, scoreQuiz };
})();
