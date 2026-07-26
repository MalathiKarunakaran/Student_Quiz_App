/**
 * auth-guard.js
 * ---------------------------------------------------------------------------
 * Firebase Authentication wrapper shared by teacher.html (Step 5 only) and
 * dashboard.html (the whole page). This module never decides WHO counts as a
 * teacher — that's enforced server-side (Firestore security rules for reads,
 * lib/firebaseAdmin.js's TEACHER_EMAILS allowlist for the API endpoints).
 * Here, "signed in" just means "has a Firebase Auth session"; a signed-in
 * non-teacher account would still get 403s from the API and empty results
 * from Firestore reads (which the rules deny outright).
 * ---------------------------------------------------------------------------
 */

const AuthGuard = (() => {
  function auth() {
    return firebase.auth(FirebaseApp.getApp());
  }

  function onAuthChange(callback) {
    return auth().onAuthStateChanged(callback);
  }

  function getCurrentUser() {
    return auth().currentUser;
  }

  async function signIn(email, password) {
    const cred = await auth().signInWithEmailAndPassword(email, password);
    return cred.user;
  }

  function signOut() {
    return auth().signOut();
  }

  /** ID token to attach as `Authorization: Bearer <token>` on teacher-only API calls. */
  async function getIdToken() {
    const user = getCurrentUser();
    if (!user) throw new Error("Not signed in.");
    return user.getIdToken();
  }

  /**
   * Renders a minimal login form into `container` and resolves once signed
   * in. Reusable inline (teacher.html Step 5) or full-page (dashboard.html).
   */
  function renderLoginForm(container, { title = "Teacher Sign-In", onSignedIn } = {}) {
    container.innerHTML = `
      <div class="card" style="max-width:420px;">
        <h2>${title}</h2>
        <div class="field">
          <label>Email</label>
          <input type="email" id="authEmail" placeholder="you@example.com">
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="authPassword">
        </div>
        <div id="authError"></div>
        <div class="btn-row">
          <button class="btn-primary" id="authSignInBtn" type="button">Sign In</button>
        </div>
      </div>
    `;

    const errBox = container.querySelector("#authError");
    const btn = container.querySelector("#authSignInBtn");
    const emailInput = container.querySelector("#authEmail");
    const passwordInput = container.querySelector("#authPassword");

    async function attempt() {
      errBox.innerHTML = "";
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) {
        errBox.innerHTML = '<div class="error-box">Enter both email and password.</div>';
        return;
      }
      btn.disabled = true;
      btn.textContent = "Signing in…";
      try {
        const user = await signIn(email, password);
        if (onSignedIn) onSignedIn(user);
      } catch (e) {
        errBox.innerHTML = `<div class="error-box">Sign-in failed: ${e.message}</div>`;
        btn.disabled = false;
        btn.textContent = "Sign In";
      }
    }

    btn.addEventListener("click", attempt);
    passwordInput.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  }

  return { onAuthChange, getCurrentUser, signIn, signOut, getIdToken, renderLoginForm };
})();
