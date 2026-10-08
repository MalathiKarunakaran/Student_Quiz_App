/**
 * submission-sync.js
 * ---------------------------------------------------------------------------
 * Writes the completed quiz submission to Firestore (js/firestore-client.js),
 * on top of the existing, unchanged localStorage save in js/storage.js — that
 * stays as the resume/offline fallback exactly as before. A failed write is
 * kept in localStorage under a `csa65pendingsync::` key and flushed by
 * retryPending(), which student.html calls once on load.
 *
 * Retries are still page-load-triggered, not background-triggered, even now
 * that sw.js exists: replaying them from the service worker would need the
 * Background Sync API, which Safari/iOS does not implement — and iOS is a
 * large share of the student devices this has to work on. A retry on next
 * open behaves identically everywhere, which is worth more here than a
 * background retry that silently works on only some phones.
 * ---------------------------------------------------------------------------
 */

const SubmissionSync = (() => {
  const PENDING_PREFIX = "csa65pendingsync::";

  /**
   * How long to wait for Firestore before giving up and queueing (ms).
   *
   * This bound is NOT optional. A Firestore write's promise resolves on server
   * acknowledgement, so with no connection it simply never settles — the SDK
   * parks the write in its own offline queue and waits indefinitely. Since
   * sync() is awaited inside QuizEngine.submitQuiz(), an unbounded wait means
   * a student who submits while offline clicks "Submit", and the results
   * screen never appears at all. Verified in a real browser: 8s+ with no
   * resolution and no rejection.
   *
   * (Before offline support existed this was masked rather than absent — the
   * Firebase SDK is loaded from a CDN, so going offline also meant `firebase`
   * was undefined and the write threw immediately. sw.js now precaches the
   * SDK, which is why the underlying hang had to be handled properly.)
   */
  const SYNC_TIMEOUT_MS = 8000;

  /** Matches the registry's own cap on max_attempts (lib/assessmentRegistry.js). */
  const ATTEMPT_CEILING = 100;

  function pendingKey(quizId, rollNo) {
    return `${PENDING_PREFIX}${quizId}::${rollNo}`;
  }

  function buildDoc({ config, quiz, answers, scoreResult, meta }) {
    const passingPercentage = config.passingPercentage || 50;
    return {
      quizId: meta.quizId,
      // §6 identity, alongside the legacy quizId/unit rather than replacing
      // them: the dashboard's existing unit filter and every submission already
      // in Firestore keep working. Null for a quiz opened the legacy way
      // (?config= or ?configFile=), which has no registry entry behind it.
      assessment_id: config.assessment_id || null,
      subject_id: config.subject_id || null,
      unit_id: config.unit_id || null,
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

  /**
   * How many attempts this quiz allows. Defaults to 1, so a legacy config with
   * no registry entry behind it behaves exactly as it always has: one attempt,
   * enforced by the document id itself.
   */
  function maxAttemptsFor(config) {
    const n = Number(config && config.max_attempts);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), ATTEMPT_CEILING) : 1;
  }

  /**
   * Returns { synced, attemptNumber?, exhausted?, reason? } — never throws, so
   * it's always safe to await at submit time.
   *
   * On a fresh submit this SEARCHES for a free attempt slot, because students
   * cannot read `submissions` (firestore.rules) and so cannot look up how many
   * attempts they have already filed. Writing is the only way to find out: a
   * taken slot refuses the write. With the default max_attempts of 1 there is
   * exactly one slot and exactly one write, which is what this did before
   * attempts existed.
   *
   * The attempt number that was actually reached is pinned into the queued copy
   * on failure, so a later replay writes that same slot instead of searching
   * again — searching on a replay is how a student who sat the quiz once would
   * end up with two attempts on file (the write that timed out can still land
   * from the SDK's own offline queue; see withTimeout).
   */
  async function sync(payload) {
    if (!FirebaseApp.isConfigured()) return { synced: false, reason: "Firebase not configured yet" };

    const doc = buildDoc(payload);
    const maxAttempts = maxAttemptsFor(payload.config);
    const key = pendingKey(doc.quizId, doc.student.rollNo);

    // Known-offline: don't make the student wait out the timeout below for a
    // write that cannot possibly succeed. (navigator.onLine being true proves
    // nothing about reachability, so the timeout still has to exist for the
    // "connected to Wi-Fi that doesn't actually route" case.)
    if (navigator.onLine === false) {
      queuePending(key, Object.assign({}, doc, { attemptNumber: 1, maxAttempts }));
      return { synced: false, reason: "No connection — saved on this device and will sync automatically later." };
    }

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      try {
        await withTimeout(FirestoreClient.saveSubmissionAttempt(doc, attemptNumber, maxAttempts), SYNC_TIMEOUT_MS);
        localStorage.removeItem(key);
        return { synced: true, attemptNumber };
      } catch (e) {
        if (FirestoreClient.isSlotTakenError(e)) {
          // This slot is filled (or the document was rejected as malformed —
          // the two are indistinguishable from here, see
          // FirestoreClient.isSlotTakenError). Either way retrying THIS slot
          // can never succeed, so move to the next one.
          continue;
        }
        // A real failure to reach the server. Pin the slot we were on so the
        // replay writes the same one rather than searching again.
        queuePending(key, Object.assign({}, doc, { attemptNumber, maxAttempts }));
        return { synced: false, attemptNumber, reason: e.message };
      }
    }

    // Every allowed slot refused the write. Queueing this would be a poison
    // entry — retried on every page load for the rest of the device's life,
    // and never able to succeed — so it is dropped, and the caller is told
    // plainly rather than being shown the "will sync later" message.
    localStorage.removeItem(key);
    return {
      synced: false,
      exhausted: true,
      reason: maxAttempts === 1
        ? "A submission for this quiz and roll number is already on file, so this attempt was not recorded."
        : `All ${maxAttempts} permitted attempts for this quiz are already on file, so this attempt was not recorded.`,
    };
  }

  function queuePending(key, doc) {
    try { localStorage.setItem(key, JSON.stringify(doc)); } catch (_e) { /* localStorage full/unavailable */ }
  }

  /**
   * Rejects after `ms` if `promise` hasn't settled. The underlying Firestore
   * write is deliberately not cancelled — the SDK may still deliver it from
   * its own offline queue once a connection returns. If it does, the queued
   * copy here retries later and comes back ALREADY_EXISTS, which sync() and
   * retryPending() both already treat as success, so the duplicate resolves
   * itself rather than producing a second document.
   */
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Could not reach the server in time — saved on this device and will sync automatically later.")),
        ms
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Call once on page load to flush any submissions that failed to sync last time.
   *
   * Each queued document carries the attempt slot it was assigned when it was
   * first submitted, and is replayed into THAT slot only — never searched into a
   * free one. A queued copy whose original write landed late therefore comes back
   * refused rather than filing a second attempt.
   */
  async function retryPending() {
    if (!FirebaseApp.isConfigured()) return;
    // Same unbounded-write hazard as sync(): with no connection every attempt
    // below would hang rather than fail, so the loop would never finish.
    if (navigator.onLine === false) return;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PENDING_PREFIX)) keys.push(k);
    }
    for (const key of keys) {
      let doc;
      try {
        doc = JSON.parse(localStorage.getItem(key));
      } catch (_e) {
        // Unparseable entry — it can never be replayed, so stop carrying it.
        localStorage.removeItem(key);
        continue;
      }
      // Queued by a build that predates attempts: slot 1 is where it would
      // have gone, and slot 1 is where it still belongs.
      const attemptNumber = Number(doc.attemptNumber) || 1;
      const maxAttempts = Number(doc.maxAttempts) || 1;
      try {
        await withTimeout(FirestoreClient.saveSubmissionAttempt(doc, attemptNumber, maxAttempts), SYNC_TIMEOUT_MS);
        localStorage.removeItem(key);
      } catch (e) {
        // A refused slot is terminal — the write cannot ever succeed, so drop it
        // instead of retrying it on every page load forever. BEFORE attempts
        // existed this branch looked for `already-exists`, which the client SDK
        // never actually returns (set() over an existing document is an UPDATE,
        // which the rules refuse as `permission-denied`), so a re-taken quiz left
        // an entry here that was retried on every single load and never cleared.
        if (FirestoreClient.isSlotTakenError(e)) {
          localStorage.removeItem(key);
          continue;
        }
        // Still just unreachable — leave it for the next load.
      }
    }
  }

  return { sync, retryPending };
})();
