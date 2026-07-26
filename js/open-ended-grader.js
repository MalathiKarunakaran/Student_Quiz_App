/**
 * open-ended-grader.js
 * ---------------------------------------------------------------------------
 * Grades descriptive/scenario/prompt-engineering/open-debugging answers via
 * the server-side keyword bank (POST /api/grade-open-ended), which only
 * exists on the Vercel deployment. On ANY failure — offline, plain GitHub
 * Pages hosting (no /api/ at all), no keyword bank generated yet for this
 * unit — falls back to the existing local plain-keyword js/scorer.js
 * scoreQuestion() logic, unchanged, exactly like js/data-loader.js already
 * does for AI question generation. A student can always finish and see a
 * result, online or not.
 * ---------------------------------------------------------------------------
 */

const OpenEndedGrader = (() => {
  const OPEN_ENDED_TYPES = ["descriptive", "scenario", "promptengineering"];

  function isOpenEnded(question) {
    if (OPEN_ENDED_TYPES.includes(question.type)) return true;
    return question.type === "debugging" && !(Array.isArray(question.acceptableAnswers) && question.acceptableAnswers.length > 0);
  }

  function localFallback(question, answer) {
    return Scorer.scoreQuestion(question, answer);
  }

  /**
   * quiz: the full generated question array (state.quiz).
   * answers: questionId -> raw answer (state.answers).
   * unit: config.filters.unit — which keyword bank to grade against.
   * Returns: { [questionId]: <same shape Scorer.scoreQuestion returns> } for
   * every open-ended question in the quiz. Never throws.
   */
  async function gradeAll(quiz, answers, unit) {
    const openEnded = quiz.filter(isOpenEnded);
    if (openEnded.length === 0) return {};

    const items = openEnded.map(q => ({ questionId: q.id, answerText: answers[q.id] || "", marks: q.marks }));
    const byId = {};

    try {
      const res = await fetch("/api/grade-open-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit, items }),
      });

      let body;
      try {
        body = await res.json();
      } catch (e) {
        throw new Error("no server available at /api/grade-open-ended (static hosting)");
      }
      if (!res.ok) throw new Error(body && body.error ? body.error : `HTTP ${res.status}`);

      (body.results || []).forEach(r => {
        if (r.found) {
          const { questionId, found, ...rest } = r;
          byId[questionId] = rest;
        }
      });
    } catch (e) {
      console.warn("OpenEndedGrader: server grading unavailable, using local plain-keyword scoring instead.", e.message);
    }

    // Anything the server didn't return a bank entry for (no bank yet for
    // this unit, or the whole call failed above) falls back locally.
    openEnded.forEach(q => {
      if (!byId[q.id]) byId[q.id] = localFallback(q, answers[q.id]);
    });

    return byId;
  }

  return { gradeAll, isOpenEnded };
})();
