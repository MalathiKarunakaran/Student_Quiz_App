# CSA65 Quiz Management System

A production-ready quiz platform for *Generative AI and Large Language Models* (CSA65). The quiz-taking experience itself is still **fully client-side** and runs on **GitHub Pages** with no exposed API keys — and since Section 29 it also **works offline and installs to a home screen**, so an unreliable campus connection no longer costs a student their attempt. Two backends now sit alongside it, both opt-in and both degrading gracefully when absent: **Vercel serverless functions** (question generation + keyword-bank generation, both Gemini-backed) and **Firebase** (Firestore + Authentication, for persistent submission storage and the teacher dashboard). See Section 27 for the full picture and `docs/firebase-setup.md` for one-time setup.

---

## 1. Project Architecture

```
Browser (student/teacher)
        │
        ▼
 ┌─────────────────────────────────────────────┐
 │  Static site served by GitHub Pages          │
 │                                               │
 │  index.html / teacher.html / student.html    │
 │        │                                     │
 │        ▼                                     │
 │  JS Modules (vanilla JS, no build step):     │
 │   data-loader → randomizer → question-render │
 │   → scorer → timer → storage → export        │
 │   → quiz-engine (orchestrator)               │
 │        │                                     │
 │        ▼                                     │
 │  data/*.json  (question banks, configs,      │
 │                 optional roster)              │
 └─────────────────────────────────────────────┘
        ▲
        │  sw.js (Service Worker, Section 29)
        │  network-first, cache as fallback —
        │  the whole app keeps working offline
        └──────────────────────────────────────
```

**Why vanilla JS instead of React:** this app has no build step, no `npm install`, and no bundler — you can edit a `.js` file directly in the GitHub web UI and it works immediately on the next page load. For a non-technical instructor maintaining this across multiple semesters, that is a significant advantage over a React/webpack pipeline, which would require a build step before every deploy. React was intentionally NOT used for this reason (per the task's "if justified" condition).

---

## 2. Folder Structure

```
csa65-quiz-app/
├── index.html                    Landing page (role picker)
├── teacher.html                  Teacher configuration panel
├── student.html                  Student quiz-taking interface
├── offline.html                  Fallback page shown offline for an uncached URL (Section 29)
├── sw.js                         Service Worker — offline caching (Section 29)
├── manifest.webmanifest          Web App Manifest — installable to a home screen (Section 29)
├── css/
│   └── style.css                 Shared responsive styles
├── js/
│   ├── data-loader.js            Fetch JSON, resolve config (URL or file)
│   ├── randomizer.js             True-random + seeded PRNG, shuffling
│   ├── question-renderer.js      Renders each of the 9 question types
│   ├── scorer.js                 Scoring logic per question type + negative marking
│   ├── timer.js                  Persistent countdown timer
│   ├── storage.js                localStorage progress/result persistence
│   ├── export.js                 CSV/JSON result downloads
│   ├── pdf-report.js             Client-side PDF exam report (jsPDF, CDN-loaded)
│   ├── integrity.js              Fullscreen lockdown + violation detection
│   ├── theme.js                  Light/dark mode toggle
│   ├── quiz-engine.js             Orchestrates the full student workflow
│   ├── teacher-config.js         Drives teacher.html's filter/generate UI
│   ├── firebase-config.js        Public Firebase Web SDK config (Section 27)
│   ├── auth-guard.js             Firebase Auth login gate (teacher.html Step 5 + dashboard.html)
│   ├── firestore-client.js       Firestore client SDK wrapper (submissions read/write)
│   ├── open-ended-grader.js      Calls the server keyword-bank grader, falls back to local scoring
│   ├── submission-sync.js        Persists each submission to Firestore, retries on failure
│   ├── sw-register.js            Registers sw.js; "offline ready" / "update available" prompts
│   └── dashboard.js              Drives dashboard.html
├── dashboard.html                 Teacher/Admin submissions dashboard (Firebase Auth-gated)
├── data/
│   ├── questions-unit1.json       Sample Unit I question bank (19 Qs, all 9 types)
│   ├── config-unit1-quiz1.json    Sample quiz configuration
│   └── students-sample.json       Optional roster (name/roll pre-fill)
├── api/
│   ├── generate-questions.js      Vercel function — Hermes Agent question generation
│   ├── generate-keywords.js       Vercel function — teacher-only keyword-bank generation
│   └── grade-open-ended.js        Vercel function — server-side keyword-bank grading (no auth, called by students)
├── assets/
│   ├── img/                       Institution logos
│   └── icons/                     PWA / favicon icon set (Section 29)
├── lib/                           Server-side modules used only by api/ (see Section 17 & 27)
├── firestore.rules                Firestore security rules (paste into console, see docs/firebase-setup.md)
├── tests/
│   └── offline-support.test.js    Optional: real-browser checks for Section 29 (Playwright)
└── docs/
    ├── README.md                  This file
    └── firebase-setup.md          One-time Firebase project setup steps
```

**Adding future units:** create `data/questions-unit2.json` (same schema), then either point a new teacher config's `questionBankFile` at it, or type the path directly into the teacher panel's "Question Bank JSON Path" field.

---

## 3. UI Wireframes (ASCII)

**Landing page (`index.html`):**
```
┌───────────────────────────────────────────┐
│  CSA65 · Generative AI and LLMs            │
│  Quiz Management System                    │
├───────────────────────────────────────────┤
│  ┌───────────────┐   ┌───────────────┐     │
│  │ 🧑‍🎓 Student    │   │ 🧑‍🏫 Instructor │     │
│  │ Take a quiz    │   │ Configure quiz │     │
│  └───────────────┘   └───────────────┘     │
├───────────────────────────────────────────┤
│  How This Works (short explainer)          │
└───────────────────────────────────────────┘
```

**Student quiz screen (`student.html`):**
```
┌───────────────────────────────────────────┐
│  [⏱ 24:12]                Priya (21CS045)  │
│  ▓▓▓▓▓▓▓░░░░░░░░░  4 of 10 answered   40%  │
├───────────────────────────────────────────┤
│  Q5 of 10                Tokenization·med  │
│  Which sub-word tokenizer does GPT use?    │
│                                             │
│  ○ WordPiece                                │
│  ○ Byte-Pair Encoding (BPE)                 │
│  ○ Character-level                          │
│  ○ Whole-word only                          │
├───────────────────────────────────────────┤
│  [← Previous]   [Next →]      [Submit Quiz]│
└───────────────────────────────────────────┘
```

**Teacher panel (`teacher.html`):** 4 stacked cards — Load Bank → Filter → Settings → Generate — each revealed progressively as the previous step completes (see Section 12).

---

## 4. Responsive Interface Design

- Single fluid column, `max-width: 900px`, centered — works from a 320px phone to a wide monitor with no separate mobile template.
- `@media (max-width: 640px)` collapses all 2/3-column grids (filters, settings) into a single column and shrinks header/typography.
- All touch targets (radio/checkbox rows, buttons) are full-width tap areas on mobile, not just the small input control itself.
- No JavaScript framework CSS dependencies — pure CSS Grid/Flexbox, loads instantly.

---

## 5. JSON Schemas

### 5.1 Question Bank (`data/questions-*.json`)
```jsonc
{
  "unit": "I",
  "unitTitle": "Fundamentals of Generative AI and LLMs",
  "questions": [
    {
      "id": "u1-mcq-001",              // unique string ID
      "unit": "I",
      "topic": "AI Fundamentals",       // free text, used for filtering
      "type": "mcq",                    // mcq | truefalse | multiselect | fillblank
                                         // | descriptive | scenario | codeoutput
                                         // | debugging | promptengineering
      "difficulty": "easy",             // easy | medium | hard
      "bloom": "remember",              // remember|understand|apply|analyze|evaluate|create
      "marks": 1,
      "co": "CO1",                      // Course Outcome this question maps to (see Section 22)
      "question": "...",
      "options": ["...","...","...","..."],   // mcq / multiselect only
      "correctAnswer": 1,                      // mcq: index into options
      "correctAnswers": [0,2],                 // multiselect: array of indices
      "acceptableAnswers": ["gradient descent"], // fillblank / codeoutput
      "caseSensitive": false,
      "keywords": ["boundary","distribution"], // descriptive/scenario/promptengineering/debugging
      "minKeywordsForFullMarks": 5,
      "modelAnswer": "...",                    // shown to instructor, not student
      "codeSnippet": "...",                    // codeoutput / debugging
      "runnable": true,                        // codeoutput/debugging only — renders an editable,
                                                // in-browser Python sandbox (Pyodide) instead of a
                                                // static code block; requires codeSnippet to be
                                                // valid, self-contained, runnable Python (Section 22)
      "explanation": "..."                     // shown to student after submit
    }
  ]
}
```

### 5.2 Quiz Configuration (`data/config-*.json`)
```jsonc
{
  "quizId": "csa65-unit1-quiz1",
  "quizTitle": "CSA65 Unit I — Fundamentals",
  "questionBankFile": "data/questions-unit1.json",
  "filters": {
    "unit": "I",
    "topics": ["all"],                 // or ["Tokenization","Embeddings"]
    "difficulty": ["easy","medium","hard"],
    "bloomLevels": ["remember","understand","apply"],
    "questionTypes": ["mcq","truefalse","fillblank"]
  },
  "numQuestions": 10,
  "randomizationMode": "seeded",       // "seeded" | "random"
  "seedSource": "rollNumber",
  "shuffleOptions": true,
  "timeLimitMinutes": 25,
  "showExplanationsAfterSubmit": true,
  "passingPercentage": 50,
  "allowReviewBeforeSubmit": true,
  "autoSubmitOnTimeout": true,
  "negativeMarking": { "enabled": false, "penaltyFraction": 0.25 },
  "violationPolicy": { "mode": "warn", "maxViolations": 3 },
  "generatePdfReport": true
}
```

- `negativeMarking.enabled` / `penaltyFraction`: when enabled, a wrong answer on an auto-scored objective question (MCQ, True/False, Fill-in-Blank, Code Output; **not** Multi-Select, which already uses proportional partial credit, and not open-ended types) deducts `penaltyFraction × question.marks`. The quiz TOTAL is floored at 0 (never a negative overall score), though an individual question's contribution can go negative in the per-question breakdown.
- `violationPolicy.mode`: `"warn"` (default — never auto-submits, just logs), `"autoSubmitAfterN"` (auto-submits once `maxViolations` violations are recorded), or `"immediate"` (auto-submits on the very first violation). A "violation" is a fullscreen exit, tab switch, or window-blur event — see Section 24.
- `generatePdfReport`: shows/hides the "Download PDF Report" button on the student results screen.

### 5.3 Student Roster (`data/students-sample.json`, optional)
```jsonc
{ "students": [ { "rollNo": "21CS001", "name": "Student One" } ] }
```

### 5.4 Firestore `submissions/{quizId}__{rollNo}` — attempt 1; `…__a{n}` for attempt *n* (Section 27)

**Document id and attempts.** Attempt 1 lives at `{quizId}__{rollNo}`, with no suffix — exactly the
id used before attempts existed, so nothing already in Firestore needs migrating and the default
one-attempt behaviour is unchanged. Attempt *n* > 1 lives at `{quizId}__{rollNo}__a{n}`, and only
exists where a teacher raised `max_attempts` on the assessment. `firestore.rules` binds the id to
`attemptNumber` in both directions, so a student cannot park a resubmission at an id of their own
choosing.

```jsonc
{
  "quizId": "...", "unit": "I", "quizTitle": "...", "topics": ["Tokenization", "..."],
  // §6 identity, alongside the legacy quizId/unit rather than replacing them.
  // null for a quiz opened the legacy way (?config= / ?configFile=), which has
  // no registry entry behind it.
  "assessment_id": "csa65-u1-quiz1", "subject_id": "csa65", "unit_id": "csa65-u1",
  "attempt_id": "csa65-unit1-quiz1__22CS001", "attemptNumber": 1, "maxAttempts": 1,
  "student": { "name": "...", "rollNo": "..." },
  "questionSnapshot": [ /* full question objects, same shape as Section 5.1 */ ],
  "answers": { "u1-mcq-001": 1, "u1-descriptive-004": "..." },
  "perQuestion": [ { "questionId","topic","type","bloom","marks","question","earned","max","correct","needsReview","keywordsFound","keywordsMissing","feedback","suggestedImprovement" } ],
  "totalEarned": 27.5, "totalMax": 30, "percentage": 91.7, "passingPercentage": 50, "passed": true,
  "timeTakenSeconds": 1340, "timeLimitSeconds": 1500, "autoSubmitted": false, "autoSubmitReason": null,
  "violations": [ { "type":"tabswitch", "at":"..." } ], "violationCount": 1, "violationBreakdown": {"tabswitch":1,"windowblur":0,"fullscreenexit":0},
  "submittedAt": "<server timestamp>", "reviewStatus": "pending", "reviewedBy": null, "reviewedAt": null
}
```

### 5.5 Firestore `keywordBanks/{assessment_id}` (Section 17/27 — never readable/writable by any client, admin-SDK only)

Keyed by `assessment_id`. It was keyed by the bare unit (`keywordBanks/I`), which meant two
subjects that both had a "Unit I" shared one rubric and the second one generated silently
overwrote the first — see `docs/AUDIT.md` section H item 4. Documents under the old key are
still read as a fallback by `api/grade-open-ended.js`, so banks generated before the change
keep grading until they are regenerated; no data migration is required.

```jsonc
{
  "schemaVersion": 2,
  "assessment_id": "csa65-u1-quiz1", "subject_id": "csa65", "unit_id": "csa65-u1",
  "unit": "I", "unitTitle": "Fundamentals of Generative AI and LLMs",
  "sourceContentHash": "sha256...", "sourceRef": { "kind": "material", "material_id": "..." },
  "generatedAt": "<server timestamp>", "generatedBy": "...", "model": "gemini-2.0-flash",
  "entries": {
    "u1-descriptive-004": {
      "topic": "Tokenization", "questionText": "...",
      "keywords": [
        { "term":"tokenization", "category":"learning-objective", "weight":4, "required":true, "synonyms":["tokenisation","tokenizing"] },
        { "term":"byte-pair encoding", "category":"concept", "weight":3, "required":false, "synonyms":["BPE","byte pair encoding"] }
      ],
      "totalWeight": 12, "targetWeightForFullMarks": 9, "minKeywordsForFullMarks": 3, "requiredCount": 1
    }
  }
}
```

**`required` vs `optional` concepts.** Weight alone could not express "this must be present": a
weight-4 `learning-objective` could be skipped entirely and still reach full marks if enough
weight-1 and weight-2 terms compensated. `required` is the separate axis that closes that. At
grading time the weighted ratio decides the mark and the fraction of required concepts present
**caps** it, so naming extra optional terms can never substitute for a missing required one.
`lib/keywordBankValidator.js` allows at most half an entry's keywords to be required (demoting
the lightest excess and reporting a warning), because "mark everything important" is a known
failure mode of asking an LLM to rank.

A bank generated before this existed has no `required` field anywhere, so it has zero required
concepts and scores exactly as it did before — `lib/keywordMatcher.js` honours only an explicit
`required: true` and never infers it from the category at grading time. Regenerating a bank is
what opts an assessment into the stricter rubric. `schemaVersion` distinguishes the two, and a
v1 document is rebuilt even when its source text is unchanged.

**Returned per answer**, on top of the existing fields: `coveragePercent` (earned ÷ **total**
weight — "how much of the rubric did this answer cover", which is deliberately not the same
question as "did it earn full marks", since `targetWeightForFullMarks` is ~60% of total weight),
`requiredCoveragePercent` (`null` for a legacy bank) and `keywordsMissingRequired`.

---

## 6. JavaScript Architecture and Module Organization

| Module | Responsibility | Depends on |
|---|---|---|
| `data-loader.js` | fetch JSON, resolve config from URL/file, base64 encode/decode | none |
| `randomizer.js` | seeded/true-random shuffling, question selection | none |
| `scorer.js` | per-question-type scoring | none |
| `timer.js` | persistent countdown, auto-submit trigger | none |
| `storage.js` | localStorage read/write for progress & results | none |
| `question-renderer.js` | DOM rendering per question type | none |
| `export.js` | CSV/JSON downloads | none |
| `pdf-report.js` | client-side PDF report (jsPDF, CDN-loaded on demand) | none |
| `integrity.js` | fullscreen lockdown, violation detection, input blocking | none |
| `theme.js` | light/dark mode toggle | none |
| `quiz-engine.js` | orchestrates all of the above into the full workflow | all of the above, plus `open-ended-grader.js` + `submission-sync.js` |
| `teacher-config.js` | drives the teacher filter/generate UI | `data-loader.js`, `auth-guard.js` (Step 5 only) |
| `firebase-config.js` | public Firebase Web SDK config + `FirebaseApp.isConfigured()` | firebase compat SDK (CDN) |
| `auth-guard.js` | Firebase Auth login gate, ID tokens | `firebase-config.js` |
| `firestore-client.js` | Firestore reads/writes for submissions | `firebase-config.js` |
| `open-ended-grader.js` | calls `/api/grade-open-ended`, falls back to `scorer.js` locally | `scorer.js` |
| `submission-sync.js` | writes a completed submission to Firestore, retries on failure | `firestore-client.js`, `firebase-config.js` |
| `dashboard.js` | drives `dashboard.html` (search/filter/review/export) | `auth-guard.js`, `firestore-client.js`, `export.js`, `pdf-report.js` |

Every module uses the **Revealing Module Pattern** (`const X = (() => {...; return {...}; })();`) — no classes except `QuizTimer`, no external dependencies, no bundler needed. Each file can be opened and edited independently.

---

## 7. Randomization Algorithms

**True Random:** uses `window.crypto.getRandomValues()` (falls back to `Math.random()` on very old browsers) to drive a Fisher-Yates shuffle. Different every time, even for the same student re-opening the quiz.

**Seeded (Deterministic):** the student's roll number is hashed (djb2 string hash) into a 32-bit integer seed, which drives a `mulberry32` PRNG. The SAME roll number always produces the SAME Fisher-Yates shuffle output — so a given student always gets the same question set/order, but different students get different sets. This is what makes seeded mode useful for fairness + reproducibility (an instructor can regenerate exactly what a specific student saw, for review/regrading, just by re-entering their roll number).

Both modes also optionally shuffle each MCQ/multiselect question's **option order** independently, with correct-answer indices remapped automatically (verified in testing — see Section 20).

---

## 8. Quiz Generation Workflow

1. Student opens `student.html` (with or without a `?config=` / `?configFile=` URL parameter).
2. `DataLoader.resolveConfig()` determines the active config (URL param takes priority, then `?configFile=`, then a default path).
3. `DataLoader.loadQuestionBank()` fetches the referenced JSON question bank.
4. `QuizEngine.filterQuestions()` applies unit/topic/difficulty/Bloom/type filters.
5. `Randomizer.selectQuestions()` picks N questions using the configured mode.
6. If `shuffleOptions` is true, each question's options are independently shuffled.
7. Any previously saved progress for this student+quiz (same browser) is restored.
8. The quiz renders, timer starts, and the student begins answering.

---

## 9. Scoring Algorithms

| Type | Method |
|---|---|
| MCQ, True/False | Exact match, full marks or zero |
| Multi-Select | **Proportional**: `max(0, correctSelected − incorrectSelected) / totalCorrect × marks` — rewards partial knowledge, penalizes wild guessing |
| Fill-in-the-Blank, Code Output | Case-insensitive (configurable) match against a list of acceptable answers |
| Debugging | Same as Fill-Blank if `acceptableAnswers` provided; otherwise treated as open-ended |
| Descriptive, Scenario, Prompt Engineering | **Weighted keyword-bank scoring when available** (Section 17/27): `js/open-ended-grader.js` sends the answer to `/api/grade-open-ended`, which scores it server-side against a teacher-generated, weighted, synonym-aware keyword bank (`lib/keywordMatcher.js`) and returns matched/missing keywords + feedback + a suggested improvement. **Falls back automatically** to the original plain-keyword `scoreOpenEnded()` in `scorer.js` (counts tagged `keywords[]` present in the answer, scaled against `minKeywordsForFullMarks`) whenever no bank has been generated for that assessment, or the Vercel deployment isn't reachable (e.g. plain GitHub Pages). Always flagged `needsReview: true` either way — **this remains keyword-based, not full semantic understanding** (see Section 18) |

**Negative marking** (optional, `config.negativeMarking`, Section 5.2): when enabled, deducts `penaltyFraction × marks` from a WRONG answer on MCQ / True-False / Fill-Blank / Code Output. Not applied to Multi-Select (already proportional) or open-ended types (never definitively "wrong"). The quiz total is floored at 0 overall.

---

## 10. Timer Implementation

- One countdown for the whole quiz (not per-question), configured via `timeLimitMinutes`.
- The timer's **start timestamp** (not remaining time) is persisted to `localStorage`. On page reload, remaining time is recalculated from `Date.now() - startTime`, so refreshing does NOT give the student extra time, and closing the tab does not pause the clock.
- At 60 seconds remaining, the timer badge turns red (`.low-time` class) as a visual warning.
- At 0, `onExpire` fires automatically, which triggers a full auto-submit (see Section 8 bug-fix note in Section 20).

---

## 11. Progress Tracking

- A progress bar shows `X of N answered` and percentage, updated live as each question is answered (not just visited).
- Progress (answers + current question index) is saved to `localStorage` after every answer and every navigation — a browser crash or accidental tab close does not lose work, as long as the student returns on the **same browser/device** (there is no server, so cross-device sync is not possible — see Section 18).

---

## 12. Teacher Configuration Panel

`teacher.html` is a 4-step progressive form:
1. **Load Question Bank** — type/confirm the JSON path; the app reads it and discovers all topics/types/difficulties/Bloom levels actually present.
2. **Filter Questions** — checkboxes are auto-populated from what's actually in the bank (no hardcoding); a live counter shows how many questions match the current filter combination.
3. **Quiz Settings** — title, question count, time limit, passing %, randomization mode, toggles (shuffle options / show explanations / allow review), negative marking (enable + penalty fraction), violation policy (warn / auto-submit after N / immediate), and whether students get a PDF report download.
4. **Generate** — either:
   - **Shareable link** (recommended): the entire config is base64-encoded directly into the URL query string. Zero repo commits needed — copy the link, send it to students, done.
   - **Download config JSON**: for instructors who prefer to commit a permanent config file to the repo (e.g. `data/config-unit1-final.json`) for long-term recordkeeping.
5. **Generate Keyword Bank from Syllabus** (Section 17/27) — the only part of `teacher.html` that requires signing in. Pick the **assessment** the rubric belongs to (or the legacy unit-wide option, which every assessment on that unit falls back to when it has none of its own), then optionally upload a `.docx`/`.pdf` syllabus. The file is optional when the chosen assessment's unit already has stored material or a committed syllabus path — the text extracted at upload is reused rather than asking for the same document twice. A Vercel function hashes the source text, skips re-generation if unchanged, and otherwise asks Gemini to produce a weighted keyword bank (with `required`/`optional` concept flags) for every descriptive/scenario/prompt-engineering/open-debugging question, storing it in Firestore for `open-ended-grader.js` to use automatically on future submissions.

Steps 1-4 never touch student data and remain fully unauthenticated, exactly as before — only Step 5 requires sign-in.

---

## 13. Student Workflow

1. Open the link the instructor shared (or `student.html` directly if a default config file is set up).
2. Enter name + roll number → click **Start Quiz**.
3. Answer questions one at a time; navigate with Previous/Next; progress bar and timer update live.
4. Click **Submit Quiz** any time (with a confirmation if questions are unanswered), or the quiz **auto-submits** when time runs out.
5. See an instant results screen: score, percentage, and pass/fail only. **Answer-by-answer review and report downloads are instructor-only now** (Section 18/27) — behind the scenes, the submission (full question snapshot, answers, per-question marks, violation log, timestamps) is synced to Firestore for the instructor to review on `dashboard.html`; if that sync fails (e.g. no connection at the exact moment of submission), it's saved locally and retried automatically next time the student's device is online.

---

## 14. GitHub Pages Deployment Instructions

1. Create a new GitHub repository (e.g. `csa65-quiz-app`).
2. Upload all files in this project maintaining the exact folder structure above (`index.html`, `teacher.html`, `student.html`, `css/`, `js/`, `data/`, `docs/`).
3. Go to **Settings → Pages** in your repository.
4. Under "Source", choose the branch (usually `main`) and root folder (`/`), then Save.
5. GitHub will publish the site at `https://<your-username>.github.io/csa65-quiz-app/` within a minute or two.
6. Share `https://<your-username>.github.io/csa65-quiz-app/` with students for the landing page, or go through `teacher.html` to generate a direct quiz link.

No build step, no `npm install`, no server configuration required — it is a fully static site.

**Offline support needs nothing extra here**, but two deployment details matter (Section 29):
- GitHub Pages serves over **HTTPS**, which is what makes the Service Worker register at all — it is skipped on plain `http://` and on `file://`.
- `sw.js` and `manifest.webmanifest` must stay at the **repository root**, beside `index.html`. A worker's scope is its own directory, so a `sw.js` moved into `js/` would only control `/js/*` and would silently stop caching the app. Every path inside both files is relative, so the subpath that GitHub Pages serves from (`/<repo-name>/`) needs no configuration — **verified in a browser under both a subpath and a domain root**.

**Tell students to open the link once while on Wi-Fi before quiz day.** Nothing is cached until that first visit completes.

---

## 15. Sample JSON Datasets

Included and ready to use:
- `data/questions-unit1.json` — 19 real CSA65 Unit I questions spanning all 9 required question types (verified programmatically — see Section 20).
- `data/config-unit1-quiz1.json` — a working sample configuration.
- `data/students-sample.json` — a small sample roster.

---

## 16. Code Comments and Documentation

Every JS module opens with a header comment explaining its responsibility and design rationale; every non-trivial function has an inline comment explaining *why*, not just *what*. See the source files directly.

---

## 17. AI Integration — Hermes Agent (implemented)

The dynamic question generation part of this section is now implemented (Phase 1 of a larger AI-platform plan). It's built as a set of small, focused modules rather than one large file:

- `lib/config.js` — reads all Hermes-related environment variables (Gemini key/model, GitHub owner/repo/branch, request limits) in one place.
- `lib/githubRetriever.js` — fetches `docs/syllabus/unit{N}.md` for the requested unit from this repo (public, no token needed) to ground generation in real syllabus content, never anything invented.
- `lib/promptBuilder.js` — turns a teacher's topic/difficulty/Bloom-distribution/question-type/count selections into the LLM prompt, embedding the exact question-object schema (Section 5.1) so the model's output matches it.
- `lib/llmService.js` — the only module that calls the Gemini API (`generateContent`, JSON response mode), with retry-on-malformed-JSON.
- `lib/questionValidator.js` — rejects any generated question missing required fields or with out-of-bounds answer indices, before it can reach a student.
- `lib/duplicateChecker.js` — drops exact and near-duplicate questions (normalized text + token-overlap check).
- `lib/hermesAgent.js` — orchestrates the above end-to-end and is the only module `api/generate-questions.js` (the Vercel serverless function) calls.

On the frontend, `teacher.html`'s "Generate Questions with AI (Hermes Agent)" card calls `DataLoader.generateQuestions()` (`js/data-loader.js`) → `js/teacher-config.js`'s `generateQuestionsWithAI()`, which **appends** the results to the existing `loadedBank` array — the static, hand-authored question bank is never discarded or replaced. Because `randomizer.js`, `scorer.js`, and `question-renderer.js` are all schema-driven, AI-generated questions flow through the entire existing quiz-taking/scoring/PDF pipeline with no changes to those files.

**This only works on the Vercel-hosted deployment** (the serverless function needs a server to run and a place to hold the Gemini API key). On GitHub Pages, the same "Generate with AI" button shows a clear message instead of failing silently, and the rest of the app — loading the static bank, filtering, configuring, sharing a link, taking a quiz — is completely unaffected.

**Keyword-bank generation (implemented, Section 27):** a second, related pipeline — `api/generate-keywords.js` → `lib/keywordBankBuilder.js` → `lib/keywordPromptBuilder.js` → `lib/llmService.js`'s `callGemini()` (reused, not duplicated) → `lib/keywordBankValidator.js` — extracts weighted keywords/synonyms/concepts/learning-objectives per descriptive/scenario/prompt-engineering/open-debugging question from a teacher-uploaded syllabus (`lib/documentTextExtractor.js`, via `mammoth`/`pdf-parse`), and stores the result in Firestore (`keywordBanks/{assessment_id}`, Section 5.5) via `lib/firebaseAdmin.js`. Teacher-only, gated by a Firebase ID token checked against `TEACHER_EMAILS`. Regeneration is skipped automatically when the syllabus's extracted-text hash is unchanged (`sourceContentHash`, computed with Node's built-in `crypto`, no extra dependency).

**AI-assisted grading of open-ended answers (implemented, deliberately NOT an LLM call per answer):** `api/grade-open-ended.js` scores each descriptive/scenario/prompt-engineering answer against the keyword bank above using `lib/keywordMatcher.js` — a plain, deterministic, weighted word-boundary + synonym matcher (no LLM call at grading time, by design: no added cost/latency per submission, and the weighted "answer key" itself never has to be sent to a student's browser to be graded). `js/open-ended-grader.js` calls this endpoint and falls back to the original local `scorer.js scoreOpenEnded()` on any failure — see Section 9.

**Deliberately still deferred:** true LLM-based semantic grading (paraphrase understanding beyond keyword/synonym matching) and a fuller analytics/CO-attainment dashboard beyond what `dashboard.html` already provides (Section 28).

---

## 18. Security Considerations & Limitations

- **API keys:** the static GitHub Pages deployment still uses no API keys and runs entirely in the browser, as before. The Vercel deployment holds server-side secrets — `GEMINI_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_BASE64` — read only inside serverless functions (`lib/config.js`, `lib/firebaseAdmin.js`); never sent to or readable from client-side JS, stored as encrypted Vercel Environment Variables, never committed to the repo (see `.env.example`). The client-side `js/firebase-config.js` values are **not** secrets — see Section 27 for why that's fine.
- **Client-side MCQ/objective scoring is still visible in principle** — a technically sophisticated student could open DevTools and inspect correct answers in the loaded JSON before answering. Unchanged limitation of the objective-question path (Section 9); mitigations unchanged (seeded randomization, treat this as a **formative/practice** tool). The descriptive-answer keyword bank does **not** have this exposure — it's graded server-side and never sent to the client at all (Section 27).
- **Student submissions now leave the browser** (Section 27) — this supersedes the old "no student data leaves the browser" limitation. Firestore security rules validate submission shape/gross bounds on the public `create` path but cannot verify full per-question correctness (rules can't loop over list elements) — see `firestore.rules`'s own comment block and Section 27 for the exact gap and why it's an accepted tradeoff.
- **localStorage is still per-browser/per-device** for in-progress answers and as an offline fallback for the final result — a student switching devices mid-quiz still loses in-progress state, though a submitted result now also reaches Firestore (subject to the sync/retry caveat in Section 27) once the student is back online.

---

## 19. Browser Compatibility

Tested logic against (via the ES2017+ features used — arrow functions, template literals, `const`/`let`, `fetch`, `Array.prototype.includes`):
- Chrome/Edge 90+, Firefox 88+, Safari 14+ — full support, including Web Crypto API for true-random mode.
- Older browsers without `window.crypto.getRandomValues` automatically fall back to `Math.random()` for true-random mode (seeded mode is unaffected, as it doesn't use crypto).
- Mobile Safari / Chrome Android — fully supported via the responsive CSS (Section 4).
- Internet Explorer is **not** supported (uses arrow functions, template literals, and `fetch` with no polyfill included).
- **Offline support (Section 29)** needs a Service Worker, which requires a *secure context*: it works on `https://` and on `localhost`, and is silently skipped on `file://` and plain `http://`. Supported by Chrome/Edge 45+, Firefox 44+ and Safari 11.1+ — i.e. everything in the list above. Where it's unavailable the app runs exactly as it did before, just without offline caching: `js/sw-register.js` returns early and nothing else changes.
- **Installing to a home screen** works on Chrome/Edge (desktop + Android) and on iOS Safari via *Share → Add to Home Screen*. iOS ignores the manifest's `shortcuts`, so the quiz/instructor shortcuts are an Android/desktop nicety only.

---

## 20. Testing Checklist

Executed and verified during development (not just claimed — actually run):
- [x] All JSON data files parse as valid JSON.
- [x] All 9 question types are present in the sample bank (`mcq`, `truefalse`, `multiselect`, `fillblank`, `descriptive`, `scenario`, `codeoutput`, `debugging`, `promptengineering`).
- [x] Every standalone `.js` module passes `node --check` (syntax validity).
- [x] Every inline `<script>` block in each HTML page passes syntax validation.
- [x] Seeded randomization is deterministic: same roll number → identical question selection across repeated calls.
- [x] Seeded randomization varies by student: different roll numbers → different selections.
- [x] Option-shuffling correctly remaps `correctAnswer`/`correctAnswers` indices (verified the shuffled option text at the new correct index still matches the original correct option text).
- [x] Scoring verified correct for: MCQ (correct + incorrect), True/False, Multi-Select (full credit + partial credit), Fill-Blank (case-insensitive match), Descriptive (keyword match on a full model answer vs. an empty answer).
- [x] Base64 config encode/decode round-trips correctly, including unicode characters (em-dashes, accented letters) in the quiz title.
- [x] **Bug found and fixed during testing:** the timer's auto-submit path originally computed the score internally but never triggered the results screen to display — a student whose time expired would have been stuck looking at a frozen quiz. Fixed by adding an `onAutoSubmit` callback hook wired from `quiz-engine.js` through to `student.html`.
- [x] **Real-browser testing completed (Chrome):** full click-through of the teacher panel and a full student attempt covering all 9 question types, timer auto-submit re-verified live, results screen and CSV/JSON export verified.
- [x] **Bug found and fixed during real-browser testing:** `teacher-config.js`'s shareable-link generator embedded the raw base64 config in the URL query string unescaped. Base64 can contain `+` and `/`, and a browser's `URLSearchParams` silently decodes a literal `+` in a query value to a space — this corrupts the config on roughly 9 in 10 realistically-sized links (confirmed by reproducing it live: a student opening an affected link saw "Could not parse the 'config' URL parameter — the link may be corrupted"). This is a browser-only bug — Node's isolated `atob`/`btoa` round-trip tests never exercise real URL query-string parsing, so it was invisible until tested in an actual browser. Fixed by `encodeURIComponent`-ing the base64 string when building the link.
- [x] **Bug found and fixed during real-browser testing:** `.btn-secondary:disabled` (the Previous/Next buttons) had no CSS rule, so a disabled button on Q1 (Previous) or the last question (Next) looked fully clickable — full opacity, `cursor: pointer`, same colors as enabled — even though the native `disabled` attribute silently blocked the click. Only visible by actually rendering the page; invisible to any Node-based test. Fixed by adding a `.btn-secondary:disabled` rule.

### Offline support (Section 29) — real-browser testing, Playwright + Chromium

**37 automated browser checks, all passing**, run in two deployment shapes: at a domain root, and under the GitHub Pages subpath `/Student_Quiz_App/`. They live in `tests/offline-support.test.js` and are re-runnable:

```bash
cd csa65-quiz-app
npm install --no-save playwright && npx playwright install chromium   # one time
node tests/offline-support.test.js
```

This is **optional developer tooling only** — the app itself still has no build step and no dependencies, and nothing in `tests/` is needed to edit, deploy or run it. The script starts and stops its own static servers, so nothing has to be running first.

- [x] Worker registers, activates, and precaches 39 entries; scope is correct in **both** deployment shapes (a root-scoped worker would have silently failed on GitHub Pages).
- [x] With the network cut: `index.html` and `student.html` load and style correctly, the question bank and config load from cache, a full 15-question attempt scores, and the result is written to `localStorage`.
- [x] An offline submission is **queued, not lost** — a `csa65pendingsync::` record is written for retry.
- [x] A shareable `student.html?config=…` link resolves offline via `ignoreSearch`.
- [x] An uncached URL opened offline falls back to `offline.html`.
- [x] **No staleness:** a question bank edited on disk while online is served fresh, not from cache — the GitHub-UI-edit property of Section 1 is preserved. Verified by editing the file mid-test and reading back the edit.
- [x] `teacher.html` and `dashboard.html` still load, render and gate correctly with the worker active; no uncaught errors on any page.
- [x] **Bug found and fixed during real-browser testing:** `sw.js` calls `clients.claim()` so the very first visit becomes offline-capable without a reload — but `clients.claim()` *also* fires `controllerchange`, and `js/sw-register.js` reloaded on any such event. The result: every first-ever visit silently reloaded itself a second or two in, wiping whatever the student had already typed into the entry form. Invisible to any Node-based test, since it only exists in the real worker lifecycle. Fixed with an `acceptedUpdate` guard so only a user-accepted update ever reloads, and pinned by a regression check that types into the field, waits out the claim, and asserts the text survived.
- [x] **Bug found and fixed during real-browser testing:** precaching the Firebase SDK (so an offline-started attempt can still sync if the connection returns before submit) had the side effect of making `firebase` *defined* while offline — where previously the CDN script simply failed to load and the Firestore write threw immediately. A Firestore write resolves only on server acknowledgement, so with no connection its promise **never settles at all**: `QuizEngine.submitQuiz()` awaits `SubmissionSync.sync()`, so a student submitting offline would click Submit and never see their results screen. Confirmed live (8 s+, no resolution, no rejection). Fixed in `js/submission-sync.js` with a `navigator.onLine` fast path plus an 8 s `withTimeout()` bound on both `sync()` and `retryPending()`. This also closes the same hazard on a flaky-but-"online" connection, which existed before offline support did.
- [x] **Bug found and fixed during real-browser testing:** `offline.html` reloaded itself whenever `navigator.onLine` was true, including on first render — an infinite loop, because the file exists on the server, so reloading while online just serves it again. The page never settled. Fixed so only the `online` *event* retries.
- [x] **Bug found and fixed during real-browser testing:** that same auto-retry then overrode a navigation the student had already started — an `online` event arriving while a tapped quiz link was in flight threw away the page they had asked for and dumped them on the home page. Reproduced live. Fixed with a `pagehide` guard plus a short delay, so a user-initiated navigation always wins.
- [x] **Dark-mode fix found by screenshot:** the toast used `--console` (#0B0C10) as its background, which sits almost exactly on top of dark mode's `--paper` (#101116) — the toast all but disappeared, leaving a faint border. It read correctly in light mode, so only rendering both themes caught it. Fixed with dedicated `--toast-*` tokens that lift the toast above the page in dark mode instead of sinking it below.

---

## 21. Suggested Enhancements (Not Yet Built)

- **Leaderboard:** would require a shared data store (e.g., a free Google Sheet + Apps Script endpoint, or Firebase free tier) since this app currently has no way for one student's browser to see another's results — a meaningful architecture change, not a small add-on.
- **Analytics dashboard:** collect instructor-side by having students email/upload their downloaded JSON results, then a small script (could be a future `analytics.html` reading multiple uploaded JSON files via `<input type="file" multiple>`) aggregates class-wide topic/Bloom-level performance.
- **CSV export:** already implemented (Section 9, `export.js`).
- **Offline support:** already implemented (Section 29, `sw.js`).
- **PDF/lecture-note-to-question-bank AI tool:** see Section 17.

---

## 22. Course Outcome (CO) Mapping

Each question in `data/questions-unit1.json` carries a `"co"` field (e.g. `"CO1"`), matching the official CSA65 syllabus's Course Outcomes:

| CO | Description |
|---|---|
| CO1 | Explain the fundamentals of AI, Generative AI, Foundation Models, Transformer architecture, tokenization, embeddings, and LLMs |
| CO2 | Apply prompt engineering techniques and utilize pre-trained LLMs through modern AI frameworks/APIs |
| CO3 | Develop applications using RAG, vector databases, and introductory AI agent concepts |
| CO4 | Design and implement multimodal Generative AI applications (text, image, speech) |
| CO5 | Deploy Generative AI applications while evaluating ethical, security, governance, and responsible-AI considerations |

Unit I (the only unit currently built) maps entirely to **CO1**, per the syllabus's own unit breakdown. `teacher.html`'s filter panel shows live CO coverage (question count + % of the current filter) for whatever subset of the bank the instructor has selected, so an instructor can confirm a generated quiz actually exercises the CO it's meant to assess. When Units II–V are added, tag each new question's `"co"` field with CO2–CO5 respectively and the coverage display updates automatically — no code changes needed.

**Program Outcome (PO) mapping was requested but not implemented:** no CO→PO matrix was found among the syllabus/rubric documents supplied. PO mapping is typically defined at the program level (e.g. an NBA/OBE CO-PO matrix), not per-course — if you have that matrix, share it and the same `"co"`-style tagging pattern can be extended to `"po"`.

---

## 23. In-Browser Python Sandbox (Runnable Code Questions)

Questions with `"runnable": true` (currently `u1-codeoutput-001`, `u1-codeoutput-002`, `u1-debugging-002`) render an **editable Python code block with a "▶ Run Code" button** instead of a static `<pre>` snippet, powered by [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) loaded lazily from a CDN on first use.

- **Still no backend, no API key:** Pyodide runs entirely in the student's browser tab — there's no code sent to any server, and the CDN only serves the (static, open-source) interpreter itself. This is the one deliberate external-CDN dependency in an otherwise fully self-contained app; if `cdn.jsdelivr.net` is unreachable, "Run Code" simply fails gracefully — it never blocks quiz-taking, because it is a **self-check sandbox only**: running code never feeds the graded answer. Students still type their actual answer into the existing scored input below the editor.
- **Why the code snippets changed:** the original `codeoutput`/`debugging` snippets referenced undefined helper functions (`tokenizer.tokenize(...)`, `softmax(...)`, `one_hot_encode(...)`) as illustrative pseudo-code — fine for a static read-only block, but not runnable. For `"runnable": true` questions the snippets were rewritten to be fully self-contained, valid Python (defining any helper functions inline) so "Run Code" produces real, correct, deterministic output — verified by actually executing each snippet (see Section 20).
- **Adding a new runnable question:** set `"runnable": true` and make sure `codeSnippet` is complete, self-contained Python with no undefined names — test it with `python3 -c "<snippet>"` before adding it to the bank.

---

## 24. Quiz-Taking Integrity Guards & Lockdown (`js/integrity.js`)

**Full-screen is mandatory.** Clicking "Start Quiz" first requests full-screen (a live user gesture, required by browser security rules) — if it's denied or unsupported, the quiz does not start and the student sees a clear error to retry. Submitting (manually, by timer, or by violation policy) automatically exits full-screen again.

**Detected during the quiz**, each logged as a *violation* with a timestamp:
- Full-screen exit (Esc key, or OS window controls)
- Tab switch / minimize (`visibilitychange`)
- Window focus loss not already covered by the above (`blur` while the tab is still visible — e.g. an undocked DevTools panel)

**Blocked outright** for the whole quiz duration: copy, cut, paste, right-click/context menu, drag, text selection outside form fields, and the common shortcut combos Ctrl/Cmd+C/V/X/P/S/U, Ctrl+Shift+I/J/C, and F12 (devtools/print/save/view-source/inspect).

**Teacher-configurable violation policy** (`config.violationPolicy.mode`, Section 5.2):
- `warn` (default) — violations are only logged and shown to the student in a banner; the quiz is never auto-submitted because of them. A student who gets a phone call mid-quiz doesn't lose their attempt.
- `autoSubmitAfterN` — auto-submits once `maxViolations` violations accumulate.
- `immediate` — auto-submits on the very first violation.

Every violation (type + timestamp) is included in the result: `meta.violationCount` and `meta.violationBreakdown` (per-type counts) appear on the results screen, in the CSV/JSON exports, and in the PDF report (Section 25).

**Honest limitation** (see also Section 18): this is all client-side JavaScript in a static, no-backend app — a technically sophisticated student can always defeat client-side checks (disabling JS, browser devtools protocol, a second physical device). These guards raise the effort bar and give the instructor visibility; they are a deterrent for formative quizzes, not a substitute for physical/human proctoring in a high-stakes exam. Some things plain JavaScript categorically cannot intercept: the PrintScreen key, and a second device photographing the screen.

---

## 25. PDF Report Generation (`js/pdf-report.js`)

Students see a "Download PDF Report" button on the results screen (when the instructor's config has `generatePdfReport: true`). It's generated entirely client-side via [jsPDF](https://github.com/parallax/jsPDF) + jspdf-autotable, lazy-loaded from a CDN on first click — the same no-backend, no-API-key pattern already used for the Pyodide Python sandbox (Section 23). If the CDN is unreachable, PDF generation fails with a clear error and the CSV/JSON downloads remain available as a fallback.

The report includes: student details (name, roll number, quiz ID), date/time submitted, time taken, the full question paper with the student's answer and the correct/model answer side-by-side for every question, marks per question, a topic-wise score table, a Bloom's-taxonomy-level score table, integrity violation count, and a final grade computed from `config.gradeScale` (or a default A+/A/B/C/D/F scale — see `PDFReport.computeGrade()`).

---

## 26. Light / Dark Mode (`js/theme.js`)

A toggle button (top-right of the header on all three pages) switches between light and dark themes, persisted to `localStorage` and applied instantly via a small inline `<head>` script (before the stylesheet paints, to avoid a flash of the wrong theme). If no preference has been saved yet, the app follows the OS/browser's `prefers-color-scheme`. All colors are CSS custom properties (`css/style.css`, `:root` / `:root[data-theme="dark"]`), so both themes stay in sync automatically as the palette evolves.

---

## 27. Persistent Storage — Firestore (`js/firestore-client.js`, `js/submission-sync.js`)

**Before this feature:** every student result lived only in `localStorage` (`js/storage.js`, keys `csa65result::{quizId}::{rollNo}`), per browser/device, and reached the instructor only if the student manually downloaded and sent a CSV/JSON/PDF file. There was no way for one browser to see another's data.

**Now:** `QuizEngine.submitQuiz()` (`js/quiz-engine.js`) still writes to `localStorage` first, exactly as before (unchanged — this remains the resume/offline fallback), and then calls `SubmissionSync.sync()` to write the full submission (Section 5.4) directly to Firestore via the client SDK, from the student's unauthenticated browser. This is a public `create`-only write path — Firestore Security Rules (`firestore.rules`) validate the document's shape and gross mark bounds before accepting it, and deny all `read`/`update`/`delete` to anyone but the signed-in teacher. The document ID is deterministic (`{quizId}__{rollNo}` for attempt 1), mirroring the existing `localStorage` key scheme — a resubmission for the same quiz+student+attempt lands on an existing document, which Firestore evaluates as an `update` and the rules allow only for the teacher, so it is refused with no extra rule logic.

**Attempts (§6).** `max_attempts` on the assessment decides how many attempts a student may file; it
defaults to **1**, so a quiz that says nothing about attempts behaves exactly as it always has.
Because students cannot read `submissions` at all, the client cannot look up how many attempts it
has already used — it *writes* to find out, trying attempt 1, then 2, up to the limit, and stopping
at the first slot that accepts. With the default of 1 that is a single write, as before.

Two details that are easy to get wrong and are covered by `tests/attempt-identity.test.js`:

- **A refused write is terminal, not retryable.** A blocked resubmission surfaces as
  `permission-denied` (the web SDK has no `create()`, so an overwrite is always a refused *update*;
  `already-exists` never occurs). Treating it as a transient failure is what left a re-taken quiz
  queued in `localStorage` and retried on every page load forever — fixed, see Section 20.
- **A queued submission replays into the slot it was assigned, never a freshly searched one.**
  `withTimeout()` deliberately does not cancel the underlying write, so it can still land after the
  client gave up; a replay that searched for a free slot would then file a *second* attempt for a
  student who sat the quiz once.

Server-side enforcement of the cap: for attempt 1 there is nothing to check, so no extra read is
incurred. For attempt *n* > 1 the rules read `assessments/{assessment_id}.max_attempts` directly, so
the limit is not client-trusted. If that document does not exist the write is denied — which means
**multiple attempts require the registry mirrored into Firestore (`assessments/*`), not just sitting
in `data/assessments.json`**. That is deliberately the safe default: an extra attempt is allowed
only where a live assessment record says so.

**Known limitation, stated plainly:** the cap is enforced at *submit* time, not at start time. A
student who re-opens a one-attempt quiz can sit it again and is only told at submission that it will
not be recorded (the results screen says so explicitly rather than claiming it will sync later).
Blocking the *start* needs a server-issued attempt token, which belongs with the other server-side
work in `docs/AUDIT.md` section G and is not yet built.

**Honest limitation** (same posture as `js/integrity.js`'s own disclosed limitations, Section 24): the rules validate *shape and gross bounds*, not that every individual `perQuestion[i].earned` is truly consistent with the corresponding answer — `rules_version = '2'` cannot loop over list elements. A determined client could still hand-craft a structurally valid but fabricated result. Closing that gap fully would require a Cloud Functions trigger to re-score server-side, which forces Firebase's paid Blaze plan — deliberately out of scope; see the comment block at the top of `firestore.rules`.

**Retry behavior:** a failed Firestore write (e.g. no connection at the exact moment of submission) is retried on a later page load rather than in the background. `SubmissionSync` keeps the failed document in `localStorage` under a `csa65pendingsync::` key and flushes it via `retryPending()`, called once when `student.html` loads. There *is* now a service worker (Section 29), but background replay would additionally need the Background Sync API, which Safari/iOS does not implement — so a retry-on-next-open was kept, because it behaves identically on every student device.

**Submission never blocks on the network.** A Firestore write resolves only on server acknowledgement, so with no connection its promise never settles at all. Since `QuizEngine.submitQuiz()` awaits `SubmissionSync.sync()`, an unbounded wait would mean a student submitting offline never sees their results screen. `sync()` therefore short-circuits when `navigator.onLine` is false and, because being "online" proves nothing about reachability, also bounds the attempt with an 8-second timeout. Either path queues the document for retry instead of waiting. See Section 20 for how this was found.

**Why Firebase config values are safe to commit** (`js/firebase-config.js`): a Firebase Web SDK config (`apiKey`, `authDomain`, `projectId`, etc.) is not a secret by design — anyone can already see it by opening DevTools on any Firebase web app. The actual security boundary is `firestore.rules`, enforced server-side by Google, not the secrecy of these values.

**Keyword bank storage** (`keywordBanks/{assessment_id}`, Section 5.5) is the opposite trust model: **never** readable or writable by any client (`allow read, write: if false` in `firestore.rules`) — both generation (`api/generate-keywords.js`) and grading-time reads (`api/grade-open-ended.js`) go through the Firebase Admin SDK (`lib/firebaseAdmin.js`), which bypasses client rules entirely. This is deliberate: the keyword bank is effectively the weighted "answer key" for descriptive questions, and unlike a plain MCQ `correctAnswer` index (already disclosed as visible-in-principle, Section 18), a weighted keyword/synonym checklist is directly and precisely gameable if exposed.

**One-time setup required** (cannot be automated from this codebase — needs Firebase console + Vercel dashboard access): see `docs/firebase-setup.md` for creating the project, enabling Firestore + Authentication, creating the one teacher account, pasting in `firestore.rules`, and setting the new environment variables (`FIREBASE_SERVICE_ACCOUNT_BASE64`, `TEACHER_EMAILS`, alongside the existing `GEMINI_API_KEY`). Until that's done, `FirebaseApp.isConfigured()` returns `false` and every Firebase-dependent feature degrades to a clear "not configured yet" message instead of throwing — the rest of the app (quiz-taking, MCQ scoring, teacher config Steps 1-4) is completely unaffected.

---

## 28. Teacher Dashboard (`dashboard.html`, `js/dashboard.js`)

A new, Firebase-Auth-gated page — nothing renders until the instructor signs in (`js/auth-guard.js`), since Firestore's security rules would deny the reads anyway. Once signed in:

- **Search by Register Number** — exact match against `student.rollNo`.
- **Filter by Unit / Topic / Date range** — Unit and date range are top-level fields on each submission (Section 5.4); Topic is a Firestore `array-contains` query against a `topics[]` field (a deduped list of every topic the attempt's questions covered — added specifically because one submission spans many topics, not one).
- **View answers + evaluation details** — clicking a row expands the full per-question breakdown inline: the question text, the student's formatted answer, the correct/expected answer (both via `PDFReport.formatStudentAnswer()`/`formatCorrectAnswer()`, reused rather than re-implemented), and — for keyword-bank-graded answers — matched/missing keywords, feedback, and the suggested improvement (Section 27).
- **Download reports** — per-student CSV/PDF reuse the *existing* `js/export.js` (`exportStudentResultCSV`) and `js/pdf-report.js` (`PDFReport.generate()`) unchanged, since a Firestore submission document's field names already match what those functions expect. Bulk **Export Filtered (CSV)** is a new function, `Exporter.exportSubmissionsCSV()` (one row per submission, not per question).

`teacher.html`'s existing 4-step quiz-configuration wizard is untouched and still requires no sign-in at all — only its new Step 5 (keyword-bank generation, Section 17/27) and this dashboard require authentication, since those are the only parts that touch student answers or cost a Gemini call.

**Assessment repository:** requirement item 6 (question paper / answer key / responses / evaluation / analytics / reports, all in one place) is satisfied by the combination already described above rather than a separate duplicate store: `submissions/*` holds the question-paper snapshot + student responses + evaluation together per attempt, `keywordBanks/{assessment_id}` is the generated "answer key" for descriptive questions, and this dashboard is the analytics/reporting surface over both — no additional collection was introduced to avoid duplicating data that's already queryable here.

---

## 29. Offline Support — Service Worker + Installable App (`sw.js`, `manifest.webmanifest`, `js/sw-register.js`)

Many students take these quizzes on phones and laptops with unreliable campus Wi-Fi. Before this, a dropped connection mid-quiz meant a blank page on any reload: the answers were safe in `localStorage` (Section 11), but *the app itself* was gone. Now, after one online visit, the whole app — all four pages, the stylesheet, every JS module, the question banks and the logos — is stored on the device, and a quiz can be started, taken, scored and submitted with the network completely off.

### Caching strategy, and the constraint that drove it

Section 1 defends a specific property of this codebase: the instructor can edit a `.js` or `data/*.json` file **directly in the GitHub web UI** and it takes effect on the next page load, with no build step. A conventional cache-first service worker silently destroys that — the instructor edits a question bank, reloads, and sees the old one with no visible cause. So:

| Request | Strategy | Why |
|---|---|---|
| Same-origin (HTML, CSS, JS, `data/*.json`, images) | **Network-first**, 4 s timeout → cache | Online, the live file always wins, so the GitHub-UI-edit property survives intact and no student ever sees a stale question bank. Offline, the precached copy keeps the quiz running. On a stalling connection the cached copy is served after 4 s so a *timed* quiz isn't frozen by a hanging request — while the real response still completes in the background and refreshes the cache. |
| Version-pinned CDN assets (Firebase SDK, Pyodide, jsPDF, Google Fonts) | **Cache-first** | Every URL pins an exact version (`firebasejs/10.13.2/…`, `pyodide/v0.26.4/…`), so a cached copy can never go stale. Re-downloading Pyodide (tens of MB) per run would be far worse than a staleness risk that is zero. |
| `/api/*` | **Not intercepted** | Serverless, always needs the network, and is POST anyway. |
| `firestore.googleapis.com` | **Not intercepted** | The Firestore SDK runs its own connection and retry logic; a worker in front of it would only interfere. |

Only `GET` is ever intercepted, so no submission or API call is replayed from cache.

### What a student actually gets offline

- Any page they've opened before, including a **shareable `?config=…` link** — each of those is a unique URL that can't be precached, so the worker matches them to the one cached `student.html` with `ignoreSearch` (the config is parsed from `window.location` by the page itself, never by a server).
- A full attempt: question bank, randomization, all 9 question types, the timer, scoring and the results screen.
- An un-cached URL opened offline falls back to **`offline.html`**, which retries by itself the moment a connection returns.
- The Pyodide "Run Code" sandbox (Section 23) and PDF reports (Section 25) work offline only if the student used them at least once while online; otherwise they fail gracefully exactly as they already did.

### Installable to a home screen

`manifest.webmanifest` plus the icon set in `assets/icons/` makes the app installable (standalone window, home-screen icon, "Take a quiz"/"Configure a quiz" shortcuts). All manifest paths are relative, so this works unchanged both at a domain root (Vercel) and in the GitHub Pages subpath `/Student_Quiz_App/` — **verified in a real browser under both shapes**.

### Updates are offered, never forced

`sw.js` deliberately does **not** call `skipWaiting()`. A new version waits until every tab closes, or until the student accepts the prompt in `js/sw-register.js` — and `student.html` suppresses that prompt entirely while a quiz is on screen (`canPrompt`), because accepting it reloads the page and would end a timed attempt.

### Maintenance

`PRECACHE_URLS` in `sw.js` is a hand-written list, since there's no build step to generate one. **When you add a new `.js`, `.json`, `.html` or image file that the app needs offline, add it to that list and bump `CACHE_VERSION`.** Bumping the version is what makes browsers install the new worker and re-precache; `activate` then deletes every older `csa65-*` cache.

### Honest limitations

- **Retries are still page-load-triggered, not background-triggered.** Replaying a queued submission from the worker would need the Background Sync API, which Safari/iOS does not implement — and iOS is a large share of the student devices this has to work on. A retry on next open behaves identically on every browser, which is worth more here than a background retry that silently works on only some phones.
- **A first-ever visit must be online.** Nothing is cached until the worker installs, so a student opening the link for the very first time with no connection gets nothing. Tell students to open the link once on campus Wi-Fi before quiz day.
- **Offline submissions are queued, not delivered.** The result is saved to the device and written to Firestore on a later load (Section 27's `csa65pendingsync::` mechanism). A student who never reopens the app online never syncs — their downloaded CSV/JSON/PDF remains the fallback evidence.
- **Offline support changes nothing about integrity** (Section 24). It's the same client-side JavaScript with the same limits.

