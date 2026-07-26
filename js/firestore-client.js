/**
 * firestore-client.js
 * ---------------------------------------------------------------------------
 * Firestore client SDK wrapper. Two very different trust levels live here:
 *   - saveSubmission(): called unauthenticated, from student.html, at submit
 *     time. Firestore security rules (see firestore.rules) validate shape
 *     and gross bounds on this public `create`.
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

  function submissionDocId(quizId, rollNo) {
    return `${quizId}__${rollNo}`;
  }

  /** doc: the full submission shape described in firestore.rules' isWellFormedSubmission(). */
  async function saveSubmission(doc) {
    const id = submissionDocId(doc.quizId, doc.student.rollNo);
    await db().collection("submissions").doc(id).set({
      ...doc,
      submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  /** True if this exact quiz+student has already synced successfully (used by the retry logic). */
  async function submissionExists(quizId, rollNo) {
    const snap = await db().collection("submissions").doc(submissionDocId(quizId, rollNo)).get();
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
   * filters: { unit, rollNo, fromDate, toDate } — all optional. Firestore only
   * allows range filters on one field at a time alongside equality filters, so
   * date-range + unit is one compound query; rollNo search is a separate exact
   * equality query (see js/dashboard.js for how the two are combined).
   */
  async function querySubmissions(filters = {}) {
    let ref = db().collection("submissions");
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

  return { submissionDocId, saveSubmission, submissionExists, querySubmissions, updateReviewStatus };
})();
