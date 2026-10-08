/**
 * firestore-client.js
 * ---------------------------------------------------------------------------
 * Firestore client SDK wrapper. Two very different trust levels live here:
 *   - saveSubmissionAttempt(): called unauthenticated, from student.html, at
 *     submit time. Firestore security rules (see firestore.rules) validate
 *     shape, gross bounds and attempt identity on this public `create`.
 *   - querySubmissions()/updateSubmission(): called only from dashboard.html
 *     after AuthGuard sign-in; rules require an authenticated teacher for
 *     any read/update/delete on `submissions`, and deny all client access to
 *     `keywordBanks` entirely (that's server-admin-only, see api/grade-open-ended.js).
 * ---------------------------------------------------------------------------
 */

const FirestoreClient = (() => {
  function db() {
    return firebase.firestore(FirebaseApp.getApp());
  }

  /**
   * ATTEMPT IDENTITY (§6, docs/AUDIT.md section H item 5).
   *
   * Attempt 1 keeps the ORIGINAL id, `{quizId}__{rollNo}`, with no suffix. That
   * is the whole compatibility story in one line: every submission already in
   * Firestore keeps its id, the dashboard keeps finding it, and for the default
   * `max_attempts: 1` the structural one-attempt guarantee is byte-identical to
   * what it was before attempts existed — a second write lands on the same
   * document id and is refused. Only attempts 2+ get a suffix, and they only
   * exist when a teacher explicitly raised max_attempts.
   */
  function submissionDocId(quizId, rollNo, attemptNumber = 1) {
    const base = `${quizId}__${rollNo}`;
    return attemptNumber > 1 ? `${base}__a${attemptNumber}` : base;
  }

  /**
   * "That attempt slot is already taken."
   *
   * Firestore decides create-vs-update by whether the document already exists,
   * and `set()` on an existing one is an UPDATE — which firestore.rules allows
   * only for the teacher. So an unauthenticated student writing over an existing
   * submission gets `permission-denied`, NOT `already-exists`: the client SDK has
   * no `create()`, so `already-exists` never actually occurs here. It is matched
   * anyway, cheaply, in case this ever runs against the Admin SDK.
   *
   * The honest caveat: `permission-denied` is also what a malformed document
   * gets. The two are indistinguishable from the client, so callers must treat
   * this as "this write will never succeed", never as "confirmed already saved" —
   * see js/submission-sync.js, which stops retrying either way but does not
   * report it to the student as a successful save.
   */
  function isSlotTakenError(e) {
    const code = String((e && e.code) || "");
    if (code === "permission-denied" || code === "already-exists") return true;
    return /permission[- ]denied|already exists|insufficient permissions/i.test((e && e.message) || "");
  }

  /**
   * Writes ONE submission to ONE attempt slot. Deliberately not a loop: the
   * caller owns which slot to try and when to stop, because only it knows
   * whether this is a fresh submit (search for a free slot) or a replay of a
   * queued one (write the slot it was already assigned — searching on a replay
   * would file a second attempt for a student who only sat the quiz once).
   *
   * doc: the submission shape in firestore.rules' isWellFormedSubmission().
   * Returns the submission id written.
   */
  async function saveSubmissionAttempt(doc, attemptNumber, maxAttempts) {
    const submissionId = submissionDocId(doc.quizId, doc.student.rollNo, attemptNumber);
    await db().collection("submissions").doc(submissionId).set({
      ...doc,
      // Filled in HERE, not by the caller's buildDoc(), so that a submission
      // queued by an older build of this app — which knew nothing about
      // attempts — is upgraded to the current shape when it is finally
      // replayed, instead of being rejected by the rules for missing keys.
      assessment_id: doc.assessment_id || null,
      subject_id: doc.subject_id || null,
      unit_id: doc.unit_id || null,
      attempt_id: submissionId,
      attemptNumber,
      maxAttempts,
      submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return submissionId;
  }

  /**
   * True if this exact quiz+student+attempt has already synced successfully.
   * Teacher-only in practice — students cannot read `submissions` at all (see
   * firestore.rules), which is precisely why the sync path has to discover a
   * free attempt slot by writing rather than by looking.
   */
  async function submissionExists(quizId, rollNo, attemptNumber = 1) {
    const snap = await db().collection("submissions").doc(submissionDocId(quizId, rollNo, attemptNumber)).get();
    return snap.exists;
  }

  function toPlainSubmission(docSnap) {
    const data = docSnap.data();
    return {
      ...data,
      id: docSnap.id,
      submittedAt: data.submittedAt ? data.submittedAt.toDate().toISOString() : null,
      reviewedAt: data.reviewedAt ? data.reviewedAt.toDate().toISOString() : null,
    };
  }

  /**
   * filters: { assessment_id, unit, rollNo, fromDate, toDate } — all optional. Firestore only
   * allows range filters on one field at a time alongside equality filters, so
   * date-range + unit is one compound query; rollNo search is a separate exact
   * equality query (see js/dashboard.js for how the two are combined).
   */
  async function querySubmissions(filters = {}) {
    let ref = db().collection("submissions");
    if (filters.assessment_id) ref = ref.where("assessment_id", "==", filters.assessment_id);
    if (filters.unit) ref = ref.where("unit", "==", filters.unit);
    if (filters.rollNo) ref = ref.where("student.rollNo", "==", filters.rollNo);
    if (filters.topic) ref = ref.where("topics", "array-contains", filters.topic);
    if (filters.fromDate) ref = ref.where("submittedAt", ">=", new Date(filters.fromDate));
    if (filters.toDate) ref = ref.where("submittedAt", "<=", new Date(filters.toDate));
    ref = ref.orderBy("submittedAt", "desc").limit(filters.limit || 200);

    const snap = await ref.get();
    return snap.docs.map(toPlainSubmission);
  }

  async function updateReviewStatus(submissionId, { reviewStatus, reviewedBy }) {
    await db().collection("submissions").doc(submissionId).update({
      reviewStatus,
      reviewedBy,
      reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ---------------------------------------------------------------------------
  // Question banks (README Section 30) — a third trust level again:
  //   read  is public and unauthenticated, because student.html must fetch the
  //         paper to render the quiz (see the long note in firestore.rules);
  //   write is teacher-only, which is what makes the editor safe to expose.
  // ---------------------------------------------------------------------------

  /**
   * Firestore caps a single document at ~1 MiB. A unit bank of a few dozen
   * questions is nowhere near that, but a bank with long code snippets and
   * model answers could creep toward it, and the SDK's own error for this is
   * opaque. Checking first lets the editor say something actionable instead.
   */
  const MAX_BANK_BYTES = 900 * 1024;

  function bankSizeBytes(bank) {
    return new TextEncoder().encode(JSON.stringify(bank)).length;
  }

  async function saveQuestionBank(bankId, bank, teacherEmail) {
    const size = bankSizeBytes(bank);
    if (size > MAX_BANK_BYTES) {
      throw new Error(
        `This bank is ${(size / 1024).toFixed(0)} KB, over the ~900 KB per-document limit. ` +
        `Split it into two banks (e.g. by topic) and point separate quizzes at each.`
      );
    }
    await db().collection("questionBanks").doc(bankId).set({
      unit: bank.unit || "",
      unitTitle: bank.unitTitle || "",
      questions: bank.questions,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: teacherEmail,
    });
  }

  async function loadQuestionBank(bankId) {
    const snap = await db().collection("questionBanks").doc(bankId).get();
    if (!snap.exists) throw new Error(`No question bank named "${bankId}" exists in Firestore.`);
    const d = snap.data();
    return {
      unit: d.unit || "",
      unitTitle: d.unitTitle || "",
      questions: d.questions || [],
      updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : null,
      updatedBy: d.updatedBy || null,
    };
  }

  /** Bank ids + metadata, for the editor's "open an existing bank" picker. */
  async function listQuestionBanks() {
    const snap = await db().collection("questionBanks").get();
    return snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        unitTitle: d.unitTitle || "",
        questionCount: (d.questions || []).length,
        updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : null,
        updatedBy: d.updatedBy || null,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    submissionDocId, saveSubmissionAttempt, isSlotTakenError, submissionExists, querySubmissions, updateReviewStatus,
    saveQuestionBank, loadQuestionBank, listQuestionBanks, bankSizeBytes, MAX_BANK_BYTES,
  };
})();
