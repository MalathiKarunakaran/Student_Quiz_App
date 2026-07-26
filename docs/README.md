# CSA65 Quiz Management System

A production-ready, **fully client-side** quiz platform for *Generative AI and Large Language Models* (CSA65), built to run entirely on **GitHub Pages** with no backend server, no database, and no exposed API keys.

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
```

**Why vanilla JS instead of React:** this app has no build step, no `npm install`, and no bundler — you can edit a `.js` file directly in the GitHub web UI and it works immediately on the next page load. For a non-technical instructor maintaining this across multiple semesters, that is a significant advantage over a React/webpack pipeline, which would require a build step before every deploy. React was intentionally NOT used for this reason (per the task's "if justified" condition).

---

## 2. Folder Structure

```
csa65-quiz-app/
├── index.html                    Landing page (role picker)
├── teacher.html                  Teacher configuration panel
├── student.html                  Student quiz-taking interface
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
│   └── teacher-config.js         Drives teacher.html's filter/generate UI
├── data/
│   ├── questions-unit1.json       Sample Unit I question bank (19 Qs, all 9 types)
│   ├── config-unit1-quiz1.json    Sample quiz configuration
│   └── students-sample.json       Optional roster (name/roll pre-fill)
└── docs/
    └── README.md                  This file
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
| `quiz-engine.js` | orchestrates all of the above into the full workflow | all of the above |
| `teacher-config.js` | drives the teacher filter/generate UI | `data-loader.js` |

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
| Descriptive, Scenario, Prompt Engineering | **Keyword-based suggested score**: counts how many of the question's tagged keywords appear in the student's answer, scaled against `minKeywordsForFullMarks`. Always flagged `needsReview: true` — **this is a fast first-pass suggestion, not true semantic grading** (see Section 18, Security & Limitations) |

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

---

## 13. Student Workflow

1. Open the link the instructor shared (or `student.html` directly if a default config file is set up).
2. Enter name + roll number → click **Start Quiz**.
3. Answer questions one at a time; navigate with Previous/Next; progress bar and timer update live.
4. Click **Submit Quiz** any time (with a confirmation if questions are unanswered), or the quiz **auto-submits** when time runs out.
5. See an instant results screen: score, percentage, pass/fail, per-question breakdown, and (if enabled) explanations.
6. Download the result as CSV or JSON for personal records or to submit to the instructor.

---

## 14. GitHub Pages Deployment Instructions

1. Create a new GitHub repository (e.g. `csa65-quiz-app`).
2. Upload all files in this project maintaining the exact folder structure above (`index.html`, `teacher.html`, `student.html`, `css/`, `js/`, `data/`, `docs/`).
3. Go to **Settings → Pages** in your repository.
4. Under "Source", choose the branch (usually `main`) and root folder (`/`), then Save.
5. GitHub will publish the site at `https://<your-username>.github.io/csa65-quiz-app/` within a minute or two.
6. Share `https://<your-username>.github.io/csa65-quiz-app/` with students for the landing page, or go through `teacher.html` to generate a direct quiz link.

No build step, no `npm install`, no server configuration required — it is a fully static site.

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

**Deliberately deferred to a later phase** (not silently dropped): LLM-based semantic grading of descriptive/scenario/prompt-engineering answers (today's `scoreOpenEnded()` in `scorer.js` remains synchronous keyword-matching, unchanged), a fuller analytics/CO-attainment dashboard, and a PDF report redesign. The extension points originally sketched below are now superseded by the modules listed above.

- ~~AI-generated question banks from PDFs/lecture notes: an instructor (or a separate offline tool/script using their own API key, run locally) could generate new `data/questions-unitN.json` files from source material and drop them in.~~ — superseded by the in-app Hermes Agent above.
- **AI-assisted grading of open-ended answers** (still future work): `scorer.js`'s `scoreOpenEnded()` function is intentionally isolated — a future version could swap the keyword-matching logic for a call to an LLM API via a new serverless endpoint, following the same "secret stays server-side" pattern the Hermes Agent already establishes.
- **Recommended extension point:** add an optional `aiSuggestedScore` field to the open-ended scoring result, without needing to change the student-facing rendering at all.

---

## 18. Security Considerations & Limitations

- **API keys:** the static GitHub Pages deployment still uses no API keys and runs entirely in the browser, as before. The Vercel deployment adds one server-side secret, `GEMINI_API_KEY`, read only inside the `/api/generate-questions` serverless function (`lib/config.js`) — it is never sent to or readable from client-side JS, and is stored as an encrypted Vercel Environment Variable, never committed to the repo (see `.env.example`).
- **Client-side scoring is visible in principle** — a technically sophisticated student could open browser DevTools and inspect the correct answers in the loaded JSON before answering. This is an inherent limitation of any zero-backend static quiz app. Mitigations: (a) use seeded randomization so question order/selection varies per student, (b) treat high-stakes summative assessments with this limitation in mind — this tool is best suited for **formative/practice quizzes**, not final proctored exams, (c) consider a lightweight serverless function (e.g., Cloudflare Workers free tier) in a future iteration if a genuinely tamper-proof answer key is required.
- **No student data leaves the browser** — results are only downloaded locally by the student; there is no automatic submission to the instructor. The instructor must collect downloaded CSV/JSON files (email, LMS upload, or a shared drive folder) to build a class report. This is the direct trade-off of having no backend/database.
- **localStorage is per-browser/per-device** — a student switching devices mid-quiz loses their in-progress state (though not a submitted result, since that's downloaded as a file).

---

## 19. Browser Compatibility

Tested logic against (via the ES2017+ features used — arrow functions, template literals, `const`/`let`, `fetch`, `Array.prototype.includes`):
- Chrome/Edge 90+, Firefox 88+, Safari 14+ — full support, including Web Crypto API for true-random mode.
- Older browsers without `window.crypto.getRandomValues` automatically fall back to `Math.random()` for true-random mode (seeded mode is unaffected, as it doesn't use crypto).
- Mobile Safari / Chrome Android — fully supported via the responsive CSS (Section 4).
- Internet Explorer is **not** supported (uses arrow functions, template literals, and `fetch` with no polyfill included).

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

---

## 21. Suggested Enhancements (Not Yet Built)

- **Leaderboard:** would require a shared data store (e.g., a free Google Sheet + Apps Script endpoint, or Firebase free tier) since this app currently has no way for one student's browser to see another's results — a meaningful architecture change, not a small add-on.
- **Analytics dashboard:** collect instructor-side by having students email/upload their downloaded JSON results, then a small script (could be a future `analytics.html` reading multiple uploaded JSON files via `<input type="file" multiple>`) aggregates class-wide topic/Bloom-level performance.
- **CSV export:** already implemented (Section 9, `export.js`).
- **Offline support:** add a Service Worker + Web App Manifest to cache `data/*.json` and all app files, enabling the quiz to be taken with an intermittent connection after first load — recommended as a near-term enhancement given many student devices have unreliable Wi-Fi.
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
