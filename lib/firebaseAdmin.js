// FirebaseAdmin — single place the Admin SDK is initialized (admin.initializeApp()
// throws if called more than once per process), mirroring how lib/config.js is
// the single place env vars are read. Used by both new endpoints:
//   - api/generate-keywords.js: verifies the caller's ID token + writes keywordBanks/{unit}
//   - api/grade-open-ended.js: reads keywordBanks/{unit} (bypassing the
//     deny-all client rules — see firestore.rules)

const admin = require("firebase-admin");
const { getFirebaseConfig } = require("./config");

let app = null;

function getAdminApp() {
  if (app) return app;

  const { serviceAccountBase64 } = getFirebaseConfig();
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, "base64").toString("utf8"));
  } catch (e) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON — " +
      "re-copy it from the Firebase service-account key file (see docs/firebase-setup.md)."
    );
  }

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return app;
}

function getFirestore() {
  return getAdminApp().firestore();
}

// Verifies the Firebase ID token sent by the client (Authorization: Bearer <token>)
// and confirms the decoded email is on the TEACHER_EMAILS allowlist. Throws a
// 401/403-flagged error on any failure — callers map err.statusCode to the HTTP response.
async function verifyTeacherToken(authorizationHeader) {
  const { teacherEmails } = getFirebaseConfig();
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader || "");
  if (!match) {
    const err = new Error("Missing Authorization header — sign in on teacher.html first.");
    err.statusCode = 401;
    throw err;
  }

  let decoded;
  try {
    decoded = await getAdminApp().auth().verifyIdToken(match[1]);
  } catch (e) {
    const err = new Error("Invalid or expired sign-in session — please sign in again.");
    err.statusCode = 401;
    throw err;
  }

  const email = (decoded.email || "").toLowerCase();
  if (!teacherEmails.includes(email)) {
    const err = new Error(`"${decoded.email}" is not an authorized teacher account.`);
    err.statusCode = 403;
    throw err;
  }

  return decoded;
}

module.exports = { getAdminApp, getFirestore, verifyTeacherToken };
