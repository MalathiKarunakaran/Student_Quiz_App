/**
 * randomizer.js
 * ---------------------------------------------------------------------------
 * Provides two randomization modes for quiz generation:
 *   1. TRUE RANDOM   — uses the browser's crypto API; different every time,
 *                      even for the same student (use when you want maximum
 *                      anti-copying variation and don't need reproducibility).
 *   2. SEEDED RANDOM — deterministic PRNG seeded from a string (typically the
 *                      student's roll number). The SAME student always gets
 *                      the SAME question set/order on every load, but
 *                      DIFFERENT students get different sets. Useful when:
 *                        - you want to regrade/re-open a quiz and see the
 *                          exact same questions that student had, or
 *                        - you want reproducible "randomness" for auditing.
 *
 * No external libraries are used — this is a self-contained implementation
 * suitable for a static GitHub Pages site with no build step.
 * ---------------------------------------------------------------------------
 */

const Randomizer = (() => {

  /**
   * Simple deterministic string hash (djb2 variant).
   * Converts any string (e.g. "21CS045") into a 32-bit integer seed.
   */
  function hashStringToSeed(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
      hash = hash & 0xFFFFFFFF; // keep it 32-bit
    }
    return hash >>> 0; // unsigned
  }

  /**
   * mulberry32 — a small, fast, seedable PRNG.
   * Returns a function that produces a new pseudo-random float in [0,1)
   * each time it's called, deterministically based on the seed.
   */
  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * True-random float generator in [0,1) using the Web Crypto API
   * (falls back to Math.random if crypto is unavailable, e.g. very old browsers).
   */
  function trueRandomFloat() {
    if (window.crypto && window.crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      window.crypto.getRandomValues(buf);
      return buf[0] / 4294967296;
    }
    return Math.random();
  }

  /**
   * Fisher-Yates shuffle. Accepts a `randFn` that returns a float in [0,1) —
   * pass either a seeded PRNG or trueRandomFloat depending on mode.
   * Returns a NEW shuffled array; does not mutate the input.
   */
  function shuffle(array, randFn) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(randFn() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Get a randomization function (rand) based on mode + optional seed string.
   * mode: "seeded" | "random"
   * seedString: e.g. student's roll number (only used when mode === "seeded")
   */
  function getRandFn(mode, seedString) {
    if (mode === "seeded") {
      const seed = hashStringToSeed(seedString || "default-seed");
      return mulberry32(seed);
    }
    return trueRandomFloat;
  }

  /**
   * Selects `count` questions from `pool` using the given rand function.
   * If count >= pool.length, returns the whole pool shuffled.
   *
   * Stratifies by question `type` so a generated quiz keeps roughly the same
   * type mix as the source bank (e.g. a bank that's 20% code/debugging
   * questions produces quizzes that are ~20% code/debugging), rather than a
   * flat shuffle — which, especially when `count` is a large fraction of
   * `pool.length`, can easily over- or under-represent a type for a given
   * student's seed purely by chance.
   */
  function selectQuestions(pool, count, randFn) {
    if (count >= pool.length) return shuffle(pool, randFn);

    const groups = new Map();
    pool.forEach(q => {
      if (!groups.has(q.type)) groups.set(q.type, []);
      groups.get(q.type).push(q);
    });
    const keys = Array.from(groups.keys());

    // Largest-remainder method: proportional integer quota per type summing to `count`.
    const raw = keys.map(k => (groups.get(k).length / pool.length) * count);
    const quota = raw.map(Math.floor);
    let leftToAssign = count - quota.reduce((a, b) => a + b, 0);
    const byRemainder = raw
      .map((r, i) => ({ i, frac: r - quota[i] }))
      .sort((a, b) => b.frac - a.frac);
    for (let r = 0; r < leftToAssign; r++) quota[byRemainder[r].i] += 1;

    let selected = [];
    keys.forEach((k, i) => {
      selected = selected.concat(shuffle(groups.get(k), randFn).slice(0, quota[i]));
    });

    // Guard: if any type had fewer questions available than its quota (only
    // possible with a very small/uneven bank), top up from the leftover pool
    // so the quiz still reaches `count` total questions.
    if (selected.length < count) {
      const selectedIds = new Set(selected.map(q => q.id));
      const leftover = shuffle(pool.filter(q => !selectedIds.has(q.id)), randFn);
      selected = selected.concat(leftover.slice(0, count - selected.length));
    }

    return shuffle(selected, randFn);
  }

  /**
   * Shuffles the OPTIONS within a single MCQ/multiselect question, keeping
   * correctAnswer / correctAnswers indices consistent with the new order.
   * Returns a new question object; does not mutate the original.
   */
  function shuffleOptions(question, randFn) {
    if (!question.options || (question.type !== "mcq" && question.type !== "multiselect")) {
      return question;
    }
    const indices = question.options.map((_, i) => i);
    const shuffledIndices = shuffle(indices, randFn);
    const newOptions = shuffledIndices.map(i => question.options[i]);

    const q = Object.assign({}, question, { options: newOptions });

    if (question.type === "mcq") {
      q.correctAnswer = shuffledIndices.indexOf(question.correctAnswer);
    } else if (question.type === "multiselect") {
      q.correctAnswers = question.correctAnswers.map(origIdx => shuffledIndices.indexOf(origIdx));
    }
    return q;
  }

  return {
    hashStringToSeed,
    mulberry32,
    trueRandomFloat,
    shuffle,
    getRandFn,
    selectQuestions,
    shuffleOptions
  };
})();
