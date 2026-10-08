/**
 * tests/attempt-identity.test.js
 * ---------------------------------------------------------------------------
 * Tests for §6 and docs/AUDIT.md section H item 5 — `attempt_id`,
 * teacher-configurable `max_attempts`, and the document-id compatibility that
 * makes both safe to add to a collection that already holds submissions.
 *
 * WHY A VM SANDBOX RATHER THAN PLAYWRIGHT. js/firestore-client.js and
 * js/submission-sync.js are browser IIFEs, not modules, so they are loaded into
 * a Node vm context with `firebase`, `FirebaseApp`, `localStorage` and
 * `navigator` stubbed. What is stubbed is only the environment; the attempt-slot
 * search, the queue policy and the pinning are the real shipped code. That
 * matters because the subtle failure this logic exists to prevent — a student
 * who sat a quiz once ending up with two attempts on file because a timed-out
 * write landed late — is a sequencing bug no amount of reading catches reliably.
 *
 * The Firestore stub models the ONE rule that drives all of this: `set()` over
 * an existing document is an update, and firestore.rules allows updates only to
 * the teacher, so an unauthenticated overwrite fails with `permission-denied`.
 *
 * Run it:
 *     cd csa65-quiz-app
 *     node tests/attempt-identity.test.js
 * ---------------------------------------------------------------------------
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const results = [];

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const APP_ROOT = path.join(__dirname, "..");

/**
 * Builds a fresh sandbox per test — each one gets its own empty Firestore and
 * its own empty localStorage, so no test can depend on another's leftovers.
 *
 * behaviour.failWith: make every write fail with this error instead, to simulate
 * an unreachable server (the case that queues rather than refuses).
 */
function makeSandbox(behaviour = {}) {
  const store = new Map();      // docId -> written data
  const writeLog = [];          // every write attempt, in order
  const localStore = new Map();

  function permissionDenied() {
    const e = new Error("Missing or insufficient permissions.");
    e.code = "permission-denied";
    return e;
  }

  const firebase = {
    firestore: () => ({
      collection: (name) => ({
        doc: (id) => ({
          set: async (data) => {
            writeLog.push({ collection: name, id, attemptNumber: data.attemptNumber });
            if (behaviour.failWith) throw behaviour.failWith();
            // The rule that shapes the whole design: an overwrite is an update,
            // and an unauthenticated update is refused.
            if (store.has(id)) throw permissionDenied();
            store.set(id, data);
          },
          get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
        }),
      }),
    }),
  };
  firebase.firestore.FieldValue = { serverTimestamp: () => "<serverTimestamp>" };

  const localStorage = {
    get length() { return localStore.size; },
    key: (i) => [...localStore.keys()][i],
    getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: (k) => localStore.delete(k),
  };

  const sandbox = {
    console,
    firebase,
    localStorage,
    navigator: { onLine: true },
    FirebaseApp: { isConfigured: () => true, getApp: () => ({}) },
    setTimeout,
    clearTimeout,
    Promise,
    TextEncoder,
  };

  const ctx = vm.createContext(sandbox);
  ["js/firestore-client.js", "js/submission-sync.js"].forEach((rel) => {
    vm.runInContext(fs.readFileSync(path.join(APP_ROOT, rel), "utf8"), ctx, { filename: rel });
  });

  return { ctx, store, writeLog, localStore };
}

/** A submit payload. maxAttempts rides on config.max_attempts, as the registry emits it. */
function payload({ maxAttempts, quizId = "csa65-unit1-quiz1", rollNo = "22CS001", assessmentId = "csa65-u1-quiz1" } = {}) {
  return {
    config: {
      assessment_id: assessmentId,
      subject_id: "csa65",
      unit_id: "csa65-u1",
      filters: { unit: "I" },
      passingPercentage: 50,
      max_attempts: maxAttempts,
    },
    quiz: [{ id: "q1", topic: "Tokenization", marks: 5 }],
    answers: { q1: "an answer" },
    scoreResult: { perQuestion: [{ questionId: "q1", earned: 5, max: 5 }], totalEarned: 5, totalMax: 5, percentage: 100 },
    meta: {
      quizId, rollNo, studentName: "A Student", quizTitle: "Unit I Quiz",
      violations: [], violationCount: 0, violationBreakdown: {},
      timeTakenSeconds: 100, timeLimitSeconds: 1500, autoSubmitted: false,
    },
  };
}

function sync(ctx, p) {
  ctx.__payload = p;
  return vm.runInContext("SubmissionSync.sync(__payload)", ctx);
}

function retryPending(ctx) {
  return vm.runInContext("SubmissionSync.retryPending()", ctx);
}

const PENDING_KEY = "csa65pendingsync::csa65-unit1-quiz1::22CS001";
const LEGACY_ID = "csa65-unit1-quiz1__22CS001";

(async () => {

// ---------------------------------------------------------------------------
// Document id compatibility — the reason no migration is needed
// ---------------------------------------------------------------------------

await testAsync("attempt 1 keeps the pre-attempts document id, with no suffix", async () => {
  const { ctx, store } = makeSandbox();
  const res = await sync(ctx, payload());
  assert.strictEqual(res.synced, true);
  assert.strictEqual(res.attemptNumber, 1);
  assert.deepStrictEqual([...store.keys()], [LEGACY_ID],
    "attempt 1 must land on exactly the id used before attempts existed");
});

await testAsync("submissionDocId suffixes only attempts past the first", async () => {
  const { ctx } = makeSandbox();
  const id = (n) => vm.runInContext(`FirestoreClient.submissionDocId("quiz", "roll", ${n})`, ctx);
  assert.strictEqual(id(1), "quiz__roll");
  assert.strictEqual(id(2), "quiz__roll__a2");
  assert.strictEqual(id(3), "quiz__roll__a3");
  assert.strictEqual(vm.runInContext('FirestoreClient.submissionDocId("quiz", "roll")', ctx), "quiz__roll",
    "the default must stay attempt 1, for any caller that predates the argument");
});

await testAsync("the written document carries the §6 identity fields", async () => {
  const { ctx, store } = makeSandbox();
  await sync(ctx, payload());
  const doc = store.get(LEGACY_ID);

  assert.strictEqual(doc.assessment_id, "csa65-u1-quiz1");
  assert.strictEqual(doc.subject_id, "csa65");
  assert.strictEqual(doc.unit_id, "csa65-u1");
  assert.strictEqual(doc.attemptNumber, 1);
  assert.strictEqual(doc.maxAttempts, 1);
  // firestore.rules checks attempt_id == submissionId; a mismatch would be
  // refused in production but silently accepted by this stub, so assert it here.
  assert.strictEqual(doc.attempt_id, LEGACY_ID);
  // The legacy fields must survive alongside them — the dashboard filters on unit.
  assert.strictEqual(doc.quizId, "csa65-unit1-quiz1");
  assert.strictEqual(doc.unit, "I");
});

await testAsync("a legacy config with no registry entry records null identity, not undefined", async () => {
  // ?config= / ?configFile= quizzes have no assessment behind them. The rules
  // require the keys to be PRESENT, so they must be null rather than absent.
  const { ctx, store } = makeSandbox();
  const p = payload();
  delete p.config.assessment_id;
  delete p.config.subject_id;
  delete p.config.unit_id;

  await sync(ctx, p);
  const doc = store.get(LEGACY_ID);
  assert.ok("assessment_id" in doc && "subject_id" in doc && "unit_id" in doc, "keys must be present");
  assert.strictEqual(doc.assessment_id, null);
  assert.strictEqual(doc.subject_id, null);
  assert.strictEqual(doc.maxAttempts, 1, "no max_attempts in config must mean one attempt");
});

// ---------------------------------------------------------------------------
// The default: exactly one attempt, as before
// ---------------------------------------------------------------------------

await testAsync("a second submit with the default of one attempt is refused, not duplicated", async () => {
  const { ctx, store } = makeSandbox();
  await sync(ctx, payload());
  const second = await sync(ctx, payload());

  assert.strictEqual(second.synced, false);
  assert.strictEqual(second.exhausted, true);
  assert.strictEqual(store.size, 1, "no second document may be created");
  assert.ok(/already on file/.test(second.reason));
});

await testAsync("REGRESSION: a refused resubmission is not queued forever", async () => {
  // Before this pass the refusal arrived as `permission-denied`, which the old
  // code did not recognise (it looked for `already-exists`, which the web SDK
  // never returns), so the submission was queued and retried on every single
  // page load for the life of the device, never able to succeed.
  const { ctx, localStore } = makeSandbox();
  await sync(ctx, payload());
  await sync(ctx, payload());

  assert.strictEqual(localStore.size, 0, "a write that can never succeed must not be left in the queue");
});

// ---------------------------------------------------------------------------
// Teacher-configured multiple attempts
// ---------------------------------------------------------------------------

await testAsync("max_attempts 3 files successive attempts in their own slots", async () => {
  const { ctx, store } = makeSandbox();

  const first = await sync(ctx, payload({ maxAttempts: 3 }));
  const second = await sync(ctx, payload({ maxAttempts: 3 }));
  const third = await sync(ctx, payload({ maxAttempts: 3 }));

  assert.deepStrictEqual([first.attemptNumber, second.attemptNumber, third.attemptNumber], [1, 2, 3]);
  assert.deepStrictEqual([...store.keys()], [LEGACY_ID, `${LEGACY_ID}__a2`, `${LEGACY_ID}__a3`]);
  assert.strictEqual(store.get(`${LEGACY_ID}__a2`).attempt_id, `${LEGACY_ID}__a2`);
  assert.strictEqual(store.get(`${LEGACY_ID}__a3`).attemptNumber, 3);
});

await testAsync("a fourth submit against max_attempts 3 is refused", async () => {
  const { ctx, store } = makeSandbox();
  for (let i = 0; i < 3; i++) await sync(ctx, payload({ maxAttempts: 3 }));
  const fourth = await sync(ctx, payload({ maxAttempts: 3 }));

  assert.strictEqual(fourth.exhausted, true);
  assert.strictEqual(store.size, 3);
  assert.ok(/All 3 permitted attempts/.test(fourth.reason));
});

await testAsync("a nonsense max_attempts falls back to one attempt, never to unlimited", async () => {
  for (const bad of [0, -5, "lots", null, NaN, 1.7]) {
    const { ctx, store } = makeSandbox();
    await sync(ctx, payload({ maxAttempts: bad }));
    const second = await sync(ctx, payload({ maxAttempts: bad }));
    assert.strictEqual(store.size, 1, `max_attempts ${JSON.stringify(bad)} must allow exactly one attempt`);
    assert.strictEqual(second.exhausted, true);
  }
});

// ---------------------------------------------------------------------------
// The queue: pinning, and the duplicate-attempt hazard it prevents
// ---------------------------------------------------------------------------

await testAsync("an unreachable server queues the submission with its slot pinned", async () => {
  const { ctx, localStore } = makeSandbox({ failWith: () => Object.assign(new Error("offline"), { code: "unavailable" }) });
  const res = await sync(ctx, payload({ maxAttempts: 3 }));

  assert.strictEqual(res.synced, false);
  assert.strictEqual(res.exhausted, undefined, "unreachable is not the same as exhausted");
  const queued = JSON.parse(localStore.get(PENDING_KEY));
  assert.strictEqual(queued.attemptNumber, 1, "the slot reached must be recorded for the replay");
  assert.strictEqual(queued.maxAttempts, 3);
});

await testAsync("a queued submission replays into its pinned slot", async () => {
  const { ctx, store, localStore } = makeSandbox();
  // Queue one by hand, as a failed sync would have left it.
  localStore.set(PENDING_KEY, JSON.stringify({
    quizId: "csa65-unit1-quiz1", unit: "I", quizTitle: "Unit I Quiz",
    student: { name: "A Student", rollNo: "22CS001" },
    assessment_id: "csa65-u1-quiz1", subject_id: "csa65", unit_id: "csa65-u1",
    attemptNumber: 2, maxAttempts: 3,
  }));

  await retryPending(ctx);
  assert.deepStrictEqual([...store.keys()], [`${LEGACY_ID}__a2`]);
  assert.strictEqual(localStore.size, 0, "a successful replay clears the queue");
});

await testAsync("REGRESSION: a replay whose original write landed late files no second attempt", async () => {
  // The hazard the pinning exists for. withTimeout deliberately does not cancel
  // the underlying write, so it can still land from the SDK's offline queue
  // after the client gave up. If the replay searched for a free slot instead of
  // writing its own, a student who sat the quiz ONCE would end up with two
  // attempts on file — and on a 3-attempt quiz nothing would refuse it.
  const { ctx, store, localStore } = makeSandbox();

  await sync(ctx, payload({ maxAttempts: 3 }));          // the write that "landed late"
  localStore.set(PENDING_KEY, JSON.stringify({            // the copy the client queued
    quizId: "csa65-unit1-quiz1", unit: "I",
    student: { name: "A Student", rollNo: "22CS001" },
    assessment_id: "csa65-u1-quiz1", attemptNumber: 1, maxAttempts: 3,
  }));

  await retryPending(ctx);

  assert.strictEqual(store.size, 1, "the replay must not create a second attempt");
  assert.deepStrictEqual([...store.keys()], [LEGACY_ID]);
  assert.strictEqual(localStore.size, 0, "and it must stop being retried");
});

await testAsync("a queued document from a build that predates attempts replays into slot 1", async () => {
  const { ctx, store, localStore } = makeSandbox();
  localStore.set(PENDING_KEY, JSON.stringify({
    quizId: "csa65-unit1-quiz1", unit: "I",
    student: { name: "A Student", rollNo: "22CS001" },
    // No attemptNumber, no maxAttempts, no assessment_id — the old shape.
  }));

  await retryPending(ctx);
  const doc = store.get(LEGACY_ID);
  assert.ok(doc, "it must still be accepted");
  assert.strictEqual(doc.attemptNumber, 1);
  assert.strictEqual(doc.maxAttempts, 1);
  assert.strictEqual(doc.attempt_id, LEGACY_ID, "the write must upgrade it to the current shape");
  assert.strictEqual(doc.assessment_id, null);
});

await testAsync("an unreachable server leaves a queued submission queued", async () => {
  const { ctx, localStore } = makeSandbox({ failWith: () => Object.assign(new Error("offline"), { code: "unavailable" }) });
  localStore.set(PENDING_KEY, JSON.stringify({
    quizId: "csa65-unit1-quiz1", student: { name: "A", rollNo: "22CS001" }, attemptNumber: 1, maxAttempts: 1,
  }));

  await retryPending(ctx);
  assert.strictEqual(localStore.size, 1, "a retryable failure must stay in the queue");
});

await testAsync("an unparseable queue entry is dropped rather than retried forever", async () => {
  const { ctx, localStore } = makeSandbox();
  localStore.set(PENDING_KEY, "{not json");
  await retryPending(ctx);
  assert.strictEqual(localStore.size, 0);
});

await testAsync("a known-offline submit queues without attempting a write at all", async () => {
  const { ctx, writeLog, localStore } = makeSandbox();
  ctx.navigator.onLine = false;

  const res = await sync(ctx, payload({ maxAttempts: 3 }));
  assert.strictEqual(res.synced, false);
  assert.strictEqual(writeLog.length, 0, "no point waiting out a timeout for a write that cannot succeed");
  assert.strictEqual(JSON.parse(localStore.get(PENDING_KEY)).attemptNumber, 1);
});

// ---------------------------------------------------------------------------
// The error classification the whole policy rests on
// ---------------------------------------------------------------------------

await testAsync("isSlotTakenError recognises a refused overwrite, by code or by message", async () => {
  const { ctx } = makeSandbox();
  const check = (err) => { ctx.__err = err; return vm.runInContext("FirestoreClient.isSlotTakenError(__err)", ctx); };

  assert.strictEqual(check({ code: "permission-denied", message: "" }), true,
    "this is what a blocked resubmission actually returns");
  assert.strictEqual(check({ code: "already-exists", message: "" }), true);
  assert.strictEqual(check({ message: "Missing or insufficient permissions." }), true,
    "the code is not always populated, so the message must be matched too");
  assert.strictEqual(check({ code: "unavailable", message: "backend unreachable" }), false,
    "an unreachable server is retryable and must NOT be read as a taken slot");
  assert.strictEqual(check({ code: "deadline-exceeded", message: "timeout" }), false);
  assert.strictEqual(check({}), false);
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
results.forEach((r) => console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.ok ? "" : `\n          ${r.error}`}`));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

})();
