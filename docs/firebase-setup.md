# Firebase Setup (one-time, manual)

This app now depends on a Firebase project for persistent submission storage,
teacher authentication, and the keyword-bank grading engine. Nothing here can
be automated from the codebase — it requires access to the Firebase console
and your Vercel project's environment variables. Do this once; you won't need
to repeat it unless you rotate credentials.

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com/ and create a new project (any
   name, e.g. "csa65-quiz-app"). Google Analytics is not needed — you can
   decline it.

## 2. Enable Firestore

1. In the left sidebar, **Build → Firestore Database → Create database**.
2. Choose **Production mode** (not test mode — the rules below are what
   actually secure it, but production mode avoids the 30-day test-mode
   auto-lockout).
3. Pick any region close to your students.

## 3. Enable Authentication

1. **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable the **Email/Password** provider.
3. Under **Users**, click **Add user** and create exactly one account for
   `malathi.learning@gmail.com` with a password you'll remember — this is the
   only account that can sign into `teacher.html`'s Step 5 and `dashboard.html`.
4. Under **Settings → Authorized domains**, add:
   - your GitHub Pages domain (e.g. `malathikarunakaran.github.io`)
   - your Vercel deployment domain (e.g. `csa65-quiz-app.vercel.app`)

   (`localhost` is already authorized by default, for local testing.)

## 4. Paste in the security rules

1. **Firestore Database → Rules** tab.
2. Replace the contents with the committed `firestore.rules` file at the root
   of this repo, then click **Publish**.
3. If you ever add a co-instructor, edit the `isTeacher()` function in both
   the console and the committed `firestore.rules` file to check an allowlist
   instead of a single email — keep the two in sync.

## 5. Get your web app config

1. **Project settings (gear icon) → General → Your apps → Add app → Web**.
2. Register any nickname (e.g. "csa65-web"). You do **not** need Firebase
   Hosting.
3. Copy the `firebaseConfig` object it shows you (`apiKey`, `authDomain`,
   `projectId`, etc.) into `js/firebase-config.js` in this repo, replacing the
   placeholder values. **This is safe to commit** — a Firebase web config is
   public by design; the security rules above are what actually protect your
   data, not secrecy of these keys.

## 6. Get a service-account key (for the Vercel serverless functions)

1. **Project settings → Service accounts → Generate new private key**. This
   downloads a JSON file — treat it like a password, never commit it.
2. Base64-encode the whole file's contents:
   - macOS/Linux: `base64 -i service-account.json | tr -d '\n'`
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))`
3. In your Vercel project: **Settings → Environment Variables**, add
   `FIREBASE_SERVICE_ACCOUNT_BASE64` with that value (alongside the existing
   `GEMINI_API_KEY`). Also set `TEACHER_EMAILS` (comma-separated if you ever
   add a co-instructor) — see `.env.example` for both.
4. For local `vercel dev` testing, put the same values in `.env.local`
   (already gitignored).

## 7. Redeploy

Push/redeploy the Vercel project so `package.json`'s new dependencies
(`firebase-admin`, `mammoth`, `pdf-parse`) install and the two new functions
(`api/generate-keywords.js`, `api/grade-open-ended.js`) go live. GitHub Pages
needs no redeploy step for Firestore/Auth themselves (the client SDK talks to
Google directly regardless of static host) — only the AI-backed steps
(question generation, keyword-bank generation, server-graded open-ended
scoring) require the Vercel deployment specifically, same as today's existing
Hermes Agent question generation.

## What you get vs. what still has known limits

- Submissions now persist in Firestore and are visible in `dashboard.html`
  from any device, not just the browser that took the quiz.
- The security rules validate submission *shape* and gross mark bounds, not
  that every individual question's score is genuinely consistent with the
  student's answer — see the comment block at the top of `firestore.rules`
  for why, and what it would take to close that gap.
- Firestore's free "Spark" plan (50K reads / 20K writes per day) is
  comfortably enough for one course. If the dashboard's filters ever show a
  Firestore error asking you to create a composite index, click the link it
  gives you — that's expected on first use of a new filter combination, not a
  bug.
