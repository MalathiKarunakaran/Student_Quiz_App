/**
 * timer.js
 * ---------------------------------------------------------------------------
 * Countdown timer for the whole quiz (not per-question). Persists its start
 * time to localStorage so that a page refresh or accidental close does NOT
 * reset the clock — the student comes back to find the same remaining time
 * they had before (or auto-submit fires immediately if time had already
 * expired while they were away).
 * ---------------------------------------------------------------------------
 */

class QuizTimer {
  /**
   * @param {number} totalMinutes - total quiz duration
   * @param {string} storageKey - localStorage key to persist the start timestamp
   * @param {function} onTick - called every second with secondsRemaining
   * @param {function} onExpire - called once when the timer reaches 0
   */
  constructor(totalMinutes, storageKey, onTick, onExpire) {
    this.totalMs = totalMinutes * 60 * 1000;
    this.storageKey = storageKey;
    this.onTick = onTick;
    this.onExpire = onExpire;
    this.intervalId = null;
    this.expired = false;

    // Restore existing start time, or set a new one if this is a fresh attempt.
    const existingStart = localStorage.getItem(this.storageKey);
    this.startTime = existingStart ? parseInt(existingStart, 10) : Date.now();
    if (!existingStart) {
      localStorage.setItem(this.storageKey, String(this.startTime));
    }
  }

  getSecondsRemaining() {
    const elapsed = Date.now() - this.startTime;
    const remainingMs = Math.max(0, this.totalMs - elapsed);
    return Math.ceil(remainingMs / 1000);
  }

  start() {
    // Fire immediately once so the UI shows correct time before the first tick.
    this._tick();
    this.intervalId = setInterval(() => this._tick(), 1000);
  }

  _tick() {
    const remaining = this.getSecondsRemaining();
    if (this.onTick) this.onTick(remaining);
    if (remaining <= 0 && !this.expired) {
      this.expired = true;
      this.stop();
      if (this.onExpire) this.onExpire();
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Call when the quiz is submitted (on time or manually) to clean up storage. */
  clearPersistence() {
    localStorage.removeItem(this.storageKey);
  }

  static formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
}
