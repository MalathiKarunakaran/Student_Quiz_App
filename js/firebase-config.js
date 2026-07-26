/**
 * firebase-config.js
 * ---------------------------------------------------------------------------
 * Public Firebase Web SDK config. This is NOT a secret — Firebase web configs
 * are meant to be embedded in client-side code; the actual security boundary
 * is firestore.rules (server-enforced), not the secrecy of these values. See
 * docs/firebase-setup.md step 5 for where these come from.
 *
 * Replace the placeholder values below with your own project's config before
 * deploying. Until you do, FirebaseApp.isConfigured() returns false and every
 * Firebase-dependent feature (submission sync, teacher login, dashboard,
 * keyword-bank generation) degrades gracefully with a clear message instead
 * of throwing.
 * ---------------------------------------------------------------------------
 */

const FIREBASE_CONFIG = {
  apiKey: "REPLACE_WITH_YOUR_FIREBASE_API_KEY",
  authDomain: "REPLACE_WITH_YOUR_PROJECT.firebaseapp.com",
  projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
  storageBucket: "REPLACE_WITH_YOUR_PROJECT.appspot.com",
  messagingSenderId: "REPLACE_WITH_YOUR_SENDER_ID",
  appId: "REPLACE_WITH_YOUR_APP_ID"
};

/** Single place every other Firebase-dependent module initializes the app from. */
const FirebaseApp = (() => {
  let app = null;

  function isConfigured() {
    return !Object.values(FIREBASE_CONFIG).some(v => String(v).startsWith("REPLACE_WITH_"));
  }

  function getApp() {
    if (!isConfigured()) {
      throw new Error("Firebase is not configured yet — see docs/firebase-setup.md, then fill in js/firebase-config.js.");
    }
    if (!app) {
      app = firebase.initializeApp(FIREBASE_CONFIG);
    }
    return app;
  }

  return { isConfigured, getApp };
})();
