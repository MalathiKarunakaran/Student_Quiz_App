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

---

## 8. Deploying rules and indexes (the CLI path)

Until now this project had no `firebase.json`, so rules could only be edited by
pasting them into the Firebase console. The CLI config added alongside this
section (`firebase.json`, `.firebaserc`, `firestore.indexes.json`) makes
`firestore.rules` and `storage.rules` in this repo the source of truth.

`firebase.json` deliberately declares **only** `firestore` and `storage`. The app
itself is served by GitHub Pages and Vercel, not Firebase Hosting, so there is no
`hosting` block — and `firebase deploy` must never be run bare, because a bare
deploy acts on every configured target.

### Order matters: client first, then rules

**`firestore.rules` now requires `assessment_id`, `subject_id`, `unit_id`,
`attempt_id`, `attemptNumber` and `maxAttempts` on every submission create.** Only
a client built after the attempt-identity change sends those. So:

1. **Push the client first.** GitHub Pages (and Vercel) serve what is committed on
   `main`. Until the new client is live, deploying these rules would refuse every
   submission from the old one.
2. **Then deploy the rules.**

Deploying in the wrong order does not lose a student's marks — the old client
queues a refused submission in `localStorage` and the new client replays it
successfully on the student's next load — but it does mean a student submitting in
that window sees "saved on this device" instead of a clean sync. Don't do it
mid-exam.

### The commands

```bash
# One-time, interactive (opens a browser):
npx firebase login

# Rules only — the safe, routine deploy:
npx firebase deploy --only firestore:rules,storage --project csa65-quiz-app
```

An invalid ruleset fails at this step **without** replacing the live rules: the
ruleset is compiled server-side before it is released. A failed deploy is
therefore safe, and its error output is also the only rules syntax check
available here — there is no `--dry-run`, and the Firestore emulator needs a Java
runtime this machine does not have.

### Indexes, separately and deliberately

```bash
npx firebase deploy --only firestore:indexes --project csa65-quiz-app
```

Kept out of the routine command above because **the first indexes deploy will
offer to delete any composite index that was created by clicking a console error
link and is not declared in `firestore.indexes.json`.** Read that prompt rather
than accepting it blindly; if it proposes deleting an index you still use, add it
to the file first. The four declared indexes cover each dashboard filter paired
with its `submittedAt` ordering; combining several filters at once still needs its
own index and will still surface a console link the first time.

### Storage rules have never been deployed

The bucket has existed since setup and has never been written to, so it has no
rules of its own. `storage.rules` must be deployed **before the first material
upload**, which the command above does.
