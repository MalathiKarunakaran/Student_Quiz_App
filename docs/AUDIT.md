# CSA65 Quiz App — Pre-Change Architecture Audit

Audit date: 2026-10-08. Scope: full workspace, ~8,000 lines excluding `package-lock.json`.
Purpose: establish what exists before implementing the Subject→Unit→Topic→Assessment redesign.

**Headline finding:** this app is considerably further along than the change request assumes.
Roughly 60% of what was requested already exists and works — AI question generation, weighted
keyword evaluation, Firestore persistence, a teacher dashboard, PDF/CSV reporting. The real gaps
are the **hierarchy** (everything is flat and unit-scoped), **material storage** (uploads are
processed and thrown away), and **the review→publish lifecycle** (absent). Those three gaps are
what the work should target. Rebuilding the parts that already work would be a regression.

---

## A. Current Architecture

Three tiers, each independently optional and degrading gracefully when absent — this is the
single best property of the existing design and must be preserved.

```
TIER 1 — Static frontend (always works, zero dependencies)
  index.html ─┬─ student.html  → quiz-engine.js orchestrates:
              │                   data-loader → randomizer → question-renderer
              │                   → scorer → timer → storage → export/pdf-report
              ├─ teacher.html  → teacher-config.js + bank-editor.js
              └─ dashboard.html→ dashboard.js
  sw.js + manifest.webmanifest → full offline capability, installable

TIER 2 — Vercel serverless (optional; absent on GitHub Pages)
  api/generate-questions → lib/hermesAgent  (Gemini question generation)
  api/generate-keywords  → lib/keywordBankBuilder (Gemini rubric generation, teacher-auth'd)
  api/grade-open-ended   → lib/keywordMatcher (deterministic weighted scoring, no auth)

TIER 3 — Firebase (optional; project `csa65-quiz-app` is live)
  Firestore: submissions, questionBanks, keywordBanks
  Auth:      teacher sign-in only; students are never authenticated
  Storage:   bucket configured in firebase-config.js but NEVER USED
```

Module style is vanilla IIFE globals, no build step, no bundler. `lib/questionValidator.js` is
deliberately dual-mode (CommonJS + browser global) so the schema has exactly one definition.
That pattern is the right template for any new shared module.

---

## B. Current Data Flow

**Student attempt:**
```
URL (?config=base64 | ?configFile=path | default)
  → DataLoader.resolveConfig()
  → DataLoader.loadQuestionBank(config.questionBankFile)   // JSON path OR "firestore:<bankId>"
  → QuizEngine.filterQuestions(bank, config.filters)        // unit/topic/difficulty/bloom/type
  → Randomizer.selectQuestions(seeded by rollNo | true-random)
  → render loop, answers → localStorage on every change
  → submit → Scorer.scoreQuiz() (local, objective)
           → OpenEndedGrader.gradeAll() (server keyword bank, falls back to local)
           → QuizStorage.saveResult() (localStorage)
           → SubmissionSync.sync() (Firestore, 8s timeout, queues on failure)
  → results screen: score/percentage/pass-fail/grade band ONLY
```

**Teacher:** load bank → filter → (optionally AI-generate) → settings → emit either a base64
`?config=` link or a downloaded `config-*.json`. Separately: upload syllabus → generate keyword
bank → written to `keywordBanks/{unit}`.

---

## C. Current Question Generation

`lib/hermesAgent.js` is a clean coordinator: `githubRetriever` (syllabus) → `promptBuilder` →
`llmService` (Gemini) → `questionValidator` → `duplicateChecker` → `assignIds`. Retries malformed
JSON up to `LLM_MAX_RETRIES`. Returns coverage tallies by topic/bloom/difficulty/type.

All nine question types are supported end to end (schema → prompt → validator → renderer → scorer).

**Per-question fields today vs. requested:**

| Requested | Status |
|---|---|
| `question_id`, `question`, `type`, `options`, `correct_answer`, `marks`, `topic`, `difficulty`, `bloom_level`, `explanation` | present (named `id`, `correctAnswer`, `bloom`) |
| `course_outcome` | present as `co` |
| `keywords` | present on open-ended types |
| `expected_concepts` | **missing** — the weighted concept list lives only in `keywordBanks`, not on the question |

**Blocking weakness:** `lib/githubRetriever.js` resolves syllabus by
`ROMAN_TO_NUMBER[unit]` → `docs/syllabus/unit{N}.md`, fetched over HTTP from a **hardcoded public
GitHub repo**. Units are limited to I–V. There is no subject dimension at all. Adding a subject,
a sixth unit, or using uploaded material as the generation source is impossible without editing
JavaScript — the exact thing requirement §2 forbids. This is the single biggest architectural
blocker in the codebase.

---

## D. Current Evaluation

Two layers, correctly separated:

1. **Objective** — `js/scorer.js`, client-side, deterministic. MCQ/true-false exact match;
   multi-select proportional with a floor at 0; fill-blank/code-output case-insensitive match
   against `acceptableAnswers`. Negative marking deliberately skips multi-select and open-ended.

2. **Open-ended** — `lib/keywordMatcher.js`, server-side only. This already implements most of
   requirement §5 and implements it well:
   - weighted concepts, weight by category (`learning-objective` 4 → `incidental` 1)
   - synonym lists per concept
   - **word-boundary regex matching, tolerant of hyphen/space variants** — explicitly *not*
     substring matching ("class" will not match inside "classify")
   - returns matched/missing concepts, feedback text, and a suggested improvement
   - the weighted rubric never leaves the server; only the computed score is returned

   `js/open-ended-grader.js` falls back to `scorer.js`'s plain substring scoring whenever the
   server or bank is unavailable, so a student can always finish.

**Gaps against §5:** no explicit `coverage_%` field (ratio is computed internally then discarded);
no distinction between *required* and *optional* keywords; no semantic/LLM second pass. The
`WEIGHT_BY_CATEGORY` scheme is a reasonable proxy for "required vs optional" but is not the same
thing — a weight-4 concept can still be skipped if other concepts compensate.

---

## E. Current Storage — answering the §6 questions directly

| What | Where | Durable? |
|---|---|---|
| In-progress answers | `localStorage` `csa65quiz::{quizId}::{rollNo}` | **No** |
| Timer start time | `localStorage` `csa65timer::{quizId}::{rollNo}` | **No** |
| Result summary (student copy) | `localStorage` `csa65result::{quizId}::{rollNo}` | **No** |
| Failed-sync queue | `localStorage` `csa65pendingsync::…` | **No** |
| **Submitted attempt (marks, answers, question snapshot, violations)** | **Firestore `submissions/{quizId}__{rollNo}`** | **Yes** |
| Generated/edited question banks | Firestore `questionBanks/{bankId}` *or* committed `data/questions-*.json` | Yes |
| Keyword rubrics | Firestore `keywordBanks/{unit}` | Yes |
| Quiz configurations | base64 in a URL, *or* a downloaded `config-*.json` the teacher commits | **No central registry** |
| **Uploaded syllabus/assignment files** | **Nowhere — extracted to text, hashed, discarded** | **No** |

**On localStorage, stated plainly:** it is not storage in any durable sense. It is per-browser,
per-device, per-origin. It is cleared by private browsing, "clear site data", iOS storage
pressure, and a different browser or machine. A student who submits on a phone and a teacher
looking at a laptop share nothing through it. It is a *resume-after-refresh cache and an
offline outbox* — nothing in it should ever be treated as a record of a submission. The existing
code is honest about this (`js/storage.js` header, README "Security & Limitations"); it has not
been oversold, and it must not be.

The durable record is Firestore, and only after `SubmissionSync.sync()` succeeds. The 8-second
timeout and the pending-retry queue are correct and well-reasoned (the comment explaining why an
unbounded Firestore write hangs forever offline is accurate).

**Entity gaps against §6:** no `assessment_id` (only `quizId`), no `attempt_id` at all. The
document ID `{quizId}__{rollNo}` enforces exactly one attempt per student per quiz, permanently —
a deliberate anti-resubmission measure that directly conflicts with §6's `attempt_id` requirement.
This needs a decision, not a silent change (see §H).

---

## F. Current PDF / Report Generation

`js/pdf-report.js` — jsPDF + jspdf-autotable, loaded from CDN at call time. Produces a full exam
report: header, student identity, score, computed grade band, per-question table with the
student's answer and the correct answer, topic/bloom averages, violation log, time taken.
`PDFReport.computeGrade()` is reused by the student results screen for the grade strip.

`js/export.js` — `exportStudentResultCSV`, `exportStudentResultJSON`, `exportSubmissionsCSV`.

**Correctly scoped already:** PDF generation and answer review are reachable only from
`dashboard.html` (teacher, auth-gated). The student results screen shows score, percentage,
pass/fail and grade band — no correct answers, no per-question breakdown, no download. §8 is
substantially already satisfied.

**Gap:** CDN-loaded jsPDF means PDF generation silently fails offline; `sw.js` does not precache it.

---

## G. Current Security Weaknesses

Taking §10's checklist literally. The existing code documents several of these honestly already —
that posture is correct and is preserved below.

| # | Can a student… | Verdict | Mechanism |
|---|---|---|---|
| 1 | Modify quiz configuration | **Yes** | `?config=<base64>` is plain base64 of the full config. Decode → set `timeLimitMinutes: 999`, `numQuestions: 1`, disable `violationPolicy` → re-encode → open. **Nothing validates it.** Most serious config-level hole. |
| 2 | Change question files | Partly | Can't write to `questionBanks` (rules require teacher). But can point `?config=` at any `questionBankFile` path, including an attacker-hosted one — `fetchJSON` has no origin restriction. |
| 3 | Modify localStorage | **Yes** | Trivially. Affects resume state and the pending-sync queue; a forged `csa65pendingsync::` entry is replayed to Firestore on next load. |
| 4 | Change marks via DevTools | **Yes** | Marks are computed client-side in `scorer.js`, then POSTed. `firestore.rules` validates shape and gross bounds only (`totalEarned <= totalMax`, `totalMax <= questions × 10`). A structurally valid 100% can be hand-crafted. Already documented in `firestore.rules`. |
| 5 | Access answer keys | **Yes** | `questionBanks` is `allow read: if true` — by necessity, since students aren't authenticated and must fetch the paper. `correctAnswer`, `acceptableAnswers`, `modelAnswer` and `explanation` all ship to the browser **before** the first question renders. Also true of any committed `data/questions-*.json` on a public repo. Documented, but it is the deepest structural issue: **the paper and the answer key are the same object.** |
| 6 | Access hidden JSON files | **Yes** | Nothing in `data/` is hidden; GitHub Pages serves the directory. |
| 7 | Download assessment material | N/A today | No material is stored. Becomes a live question the moment uploads are added. |
| 8 | Manipulate the timer | **Yes** | `QuizTimer` trusts `Date.now()` and a localStorage start timestamp. Delete the key → fresh clock. Change the system clock → unbounded time. No server-issued start time. |

**Correctly protected:** `keywordBanks` is `allow read, write: if false` — the weighted rubric is
genuinely server-only, reachable only via the Admin SDK. This asymmetry (question bank public,
rubric sealed) is deliberate and well-reasoned in the rules comments: the paper is visible the
moment the quiz starts anyway, whereas the rubric is precisely gameable.

**To be explicit:** `js/integrity.js` (fullscreen lockdown, tab-switch detection, copy/paste
blocking) raises effort and produces a visibility log. It is **not** a security control. Disabling
JavaScript defeats all of it. The file's own header says exactly this, and that honesty should
not be softened.

**Where server-side enforcement is genuinely required** (cannot be fixed client-side, at any
effort):
- Signing or server-storing the quiz configuration so it cannot be edited in transit (#1)
- Issuing and holding the attempt start time server-side (#8)
- Server-side scoring from a sealed answer key — the only real fix for #4 and #5
- Serving students a **stripped paper** (no `correctAnswer` / `modelAnswer` / `explanation`)
  with the full version readable only by the teacher

Also noted: `firestore.rules` hardcodes `malathi.learning@gmail.com`; `TEACHER_EMAILS` duplicates
the same allowlist in a second place. Two sources of truth for "who is a teacher".

---

## H. Required Modifications

Ordered by dependency. Later items genuinely require earlier ones.

1. **Assessment registry + hierarchy** (§1, §9). Introduce `assessment_id` as the primary key
   across the whole app. New Firestore collections `subjects`, `units`, `assessments`, seeded
   from a `data/assessments.json` fallback so the static tier keeps working. Everything currently
   keyed by bare `unit` becomes keyed by `assessment_id`.
2. **Decouple syllabus retrieval from the GitHub path convention** (§2, §3). Replace
   `githubRetriever`'s roman-numeral→filename mapping with a resolver that reads from stored
   material. Keep the GitHub path as a fallback so existing Unit I–V generation keeps working.
3. **Material storage + processing pipeline** (§2, §3). Firebase Storage for the uploaded file;
   a `materials/{material_id}` Firestore doc for extracted text and derived metadata. Extend
   `documentTextExtractor` from `.docx`/`.pdf` to also accept `.txt`, `.md`, `.json`. Add the
   `draft → processed → under_review → published` lifecycle — the audit found no status field
   anywhere today, so "do not publish immediately" has nothing to hang off.
4. **Keyword bank re-keying** (§5). `keywordBanks/{unit}` → `keywordBanks/{assessment_id}`.
   Today two subjects that both have a "Unit I" collide into one document. Add `required` vs
   `optional` concept flags and surface `coverage_%` in the returned result.
5. **Attempt identity** (§6). Add `assessment_id` and `attempt_id` to the submission document.
   **Requires a decision** — see the open question below.
6. **Teacher dashboard extension** (§7). Subject/unit/assessment browsing, material upload and
   review, publish/unpublish. Mostly new UI over the modules above.
7. **Student flow** (§8). Replace the raw `?configFile=` entry with an assessment picker listing
   only `published` assessments. Already compliant on the "don't show answers" half.
8. **Security hardening** (§10). Server-side config resolution (kills #1), server-issued attempt
   start time (kills #8), stripped student-facing paper (reduces #5). Each is independently
   shippable; none requires the others.

**Open decision, needed before item 5 is written:** `submissions/{quizId}__{rollNo}` currently
makes resubmission structurally impossible, which is a real anti-cheat property. Adding
`attempt_id` as §6 requires means a student *can* submit twice. Either attempts become explicitly
teacher-allowed per assessment (`maxAttempts`, default 1, enforced in rules), or the deterministic
ID stays and `attempt_id` is recorded but always `1`. The first is more faithful to §6; the second
preserves current behaviour. This changes the Firestore rules either way, so it should not be
decided silently.

---

## I. Files That Must Change

| File | Change |
|---|---|
| `lib/githubRetriever.js` | **Largest change.** Remove roman-numeral/filename coupling; resolve material by `assessment_id` from storage, GitHub path as fallback |
| `lib/keywordBankBuilder.js` | Key by `assessment_id`; source text from stored material instead of a re-uploaded file; add required/optional flags |
| `lib/keywordMatcher.js` | Return `coveragePercent`; honour required-concept minimums |
| `lib/documentTextExtractor.js` | Add `.txt`, `.md`, `.json` |
| `lib/hermesAgent.js` | Accept `assessment_id`; add `expected_concepts` to generated questions |
| `lib/promptBuilder.js` | Prompt from stored material; emit `expected_concepts` |
| `lib/questionValidator.js` | Validate `expected_concepts`, `course_outcome` |
| `api/generate-questions.js` | Teacher auth (currently **unauthenticated** — anyone can burn the Gemini quota) |
| `api/generate-keywords.js` | Take `assessment_id` instead of a file upload |
| `api/grade-open-ended.js` | Look up bank by `assessment_id` |
| `js/data-loader.js` | Resolve config from the registry; keep `?config=`/`?configFile=` working |
| `js/quiz-engine.js` | Carry `assessment_id` + `attempt_id` through submit |
| `js/submission-sync.js` | Write the new identity fields |
| `js/firestore-client.js` | CRUD for subjects/units/assessments/materials |
| `js/teacher-config.js` | Drive from the registry rather than free-text fields |
| `js/dashboard.js` | Filter by subject/unit/assessment |
| `teacher.html` / `dashboard.html` / `student.html` | New panels and pickers |
| `firestore.rules` | Rules for the new collections; teacher allowlist from a document, not a literal |
| `sw.js` | Precache jsPDF; cache the registry |
| `data/config-unit1-quiz1.json` | Unchanged — backward-compatibility fixture (§12) |

## J. New Files Required

| File | Purpose |
|---|---|
| `data/assessments.json` | Static registry fallback / seed |
| `lib/assessmentRegistry.js` | Dual-mode (Node + browser), like `questionValidator.js` — single source of truth for the hierarchy schema |
| `lib/materialProcessor.js` | Extracted text → structured metadata (topics, outcomes, concepts, definitions) |
| `lib/materialStore.js` | Firebase Storage + Firestore read/write for materials |
| `api/assessments.js` | CRUD for the registry (teacher-auth'd) |
| `api/upload-material.js` | Upload → extract → store (teacher-auth'd) |
| `api/process-material.js` | Extracted text → metadata via Gemini (teacher-auth'd) |
| `api/student-paper.js` | Serve a **stripped** paper — no answer keys (security item #5) |
| `js/assessment-picker.js` | Student-facing published-assessment list |
| `js/material-manager.js` | Teacher upload/review/publish UI |
| `storage.rules` | Firebase Storage rules — teacher write, no public read |
| `tests/*.test.js` | Per §13 |

---

## Summary

The existing codebase is well-structured, honestly documented about its own limits, and already
satisfies a substantial share of the request — particularly §4 (AI generation), §5 (weighted
keyword evaluation, which is better than the request assumes), §7 (dashboard) and §8 (student
flow restrictions). Its three-tier graceful degradation is a genuine asset and the main constraint
on how anything new gets built.

The work that actually needs doing is: **introduce the hierarchy and make `assessment_id` the
primary key**, **store and process uploaded material instead of discarding it**, and **add the
review→publish lifecycle**. The GitHub-path coupling in `githubRetriever.js` blocks all three and
should be dismantled first.

Separately and independently: the quiz config is unsigned and student-editable, the timer is
client-trusted, and the answer key ships to the browser with the paper. These are real, not
theoretical. They are not caused by the changes above and will not be fixed by them.

---

## Implementation Progress

The audit above is the **pre-change** record and is deliberately left as written. This section
tracks what has since been built against it.

### Pass 1 — assessment registry and hierarchy (§1, §9, §12) — DONE

- **New:** `lib/assessmentRegistry.js` (dual-mode, like `questionValidator.js`),
  `data/assessments.json`, `tests/assessment-registry.test.js` (20 checks).
- **Changed:** `lib/githubRetriever.js` (path coupling removed — section C's blocker),
  `js/data-loader.js` (`?assessment=<id>`), `sw.js` (v2 precache), all three HTML pages.
- `assessment_id` is now the primary key. `toQuizConfig()` projects a registry assessment into
  the legacy config shape, so the entire student pipeline runs unchanged — verified by a test
  asserting byte-equivalence with `data/config-unit1-quiz1.json`.
- All four URL forms (`?assessment=`, `?configFile=`, `?config=`, default) produce identical
  quiz behaviour. A non-published id is refused with the same message as a missing one, so
  drafts do not leak via id-guessing.
- Incidental fix: `lib/questionValidator.js` and `lib/duplicateChecker.js` were `<script>`-loaded
  by `teacher.html` but never precached, so the bank editor was silently broken offline.

### Pass 2 — material storage and processing (§2, §3) — DONE

- **New:** `lib/materialStore.js`, `lib/materialProcessor.js`, `api/upload-material.js`,
  `api/process-material.js`, `storage.rules`, `tests/material-pipeline.test.js` (26 checks).
- **Changed:** `lib/documentTextExtractor.js` (now pdf/docx/txt/md/markdown/json),
  `lib/keywordBankBuilder.js` (can source from stored material instead of a re-upload),
  `firestore.rules` (new `materials`, `assessments`, `subjects` collections).
- Section E's "uploaded assessment files → **nowhere**" is resolved: original bytes go to
  Firebase Storage under `materials/{material_id}/`, derived text and the §3 knowledge object to
  Firestore `materials/{material_id}`. Both are server-only.
- The §3 lifecycle is enforced rather than implied: `api/upload-material.js` stops at `uploaded`
  and deliberately does not chain into processing, so Upload → Process → Review → Publish is four
  distinct steps and a wrong-file upload costs no Gemini call.

**Production bug found and fixed during Pass 2.** Passing a Node `Buffer` to `pdf-parse` fails
with a bogus `bad XRef entry` on valid files once `firebase-admin` has been required into the
same process. `api/upload-material.js` requires both, so **every PDF upload would have failed**,
with an error message blaming the teacher's file. Fixed by passing `new Uint8Array(buffer)`;
covered by a regression test that was confirmed to fail when the fix is reverted.

### Pass 3 — keyword-bank re-keying, required/optional concepts, coverage_% (§5) — DONE

- **New:** `lib/registryStore.js`, `tests/keyword-bank.test.js` (24 checks).
- **Changed:** `lib/keywordBankBuilder.js`, `lib/keywordBankValidator.js`, `lib/keywordMatcher.js`,
  `lib/keywordPromptBuilder.js`, `api/grade-open-ended.js`, `js/open-ended-grader.js`,
  `js/quiz-engine.js`, `js/teacher-config.js`, `teacher.html`, `firestore.rules`.
- Section E's collision is resolved: the bank lives at `keywordBanks/{assessment_id}`, not
  `keywordBanks/{unit}`. **No data migration** — `api/grade-open-ended.js` tries the assessment key
  first and falls back to the legacy unit key, so banks already in Firestore keep grading. The
  fallback is ordered, not merged: an assessment with its own bank is never graded against a
  unit-wide one it happens to share a roman numeral with.
- Section D's "`WEIGHT_BY_CATEGORY` is a proxy for required-vs-optional but is not the same thing"
  is addressed directly. `required` is now a separate axis: the weighted ratio decides the mark and
  the fraction of required concepts present caps it, so optional terms can no longer compensate for
  a skipped learning objective. The validator caps requiredness at half an entry's keywords —
  "mark everything important" is a known LLM ranking failure, and a rubric where everything is
  required is one nobody passes.
- `coveragePercent`, `requiredCoveragePercent` and `keywordsMissingRequired` are returned per
  answer — the ratio section D found was "computed internally then discarded". Coverage is
  deliberately measured against *total* weight, not `targetWeightForFullMarks`, so a full-mark
  answer can legitimately read below 100%: the two numbers answer different questions.
- `lib/registryStore.js` is the server-side counterpart to `js/data-loader.js`'s registry loading,
  which the serverless functions could not use (no relative fetch). It is file-backed for now;
  it is the single place that needs to learn to prefer Firestore when `api/assessments.js`
  (item 6) starts writing those collections.
- Side effect worth having: with the registry resolvable server-side, an assessment whose unit
  already has stored material needs **no file sent** to generate a rubric. The syllabus upload in
  teacher.html Step 5 became optional rather than mandatory.

**Backward compatibility, deliberately verified rather than assumed.** A regression test asserts a
legacy bank (no `required` fields) produces the identical mark it did before this pass:
`lib/keywordMatcher.js` honours only an explicit `required: true` and never infers requiredness
from the category at grading time. Inferring it would have silently re-marked every bank already in
Firestore. Regenerating a bank is what opts an assessment in, and `schemaVersion` makes a v1
document rebuild even when its source text is unchanged, so no assessment is left on the old rubric
because someone forgot to tick "force regenerate".

`sw.js` was deliberately **not** bumped: same-origin requests are network-first, so an online
teacher gets the updated page immediately, and the stale precached copy only serves offline — where
rubric generation cannot run anyway. `initKeywordBankAssessments()` no-ops when its `<select>` is
absent, so an offline stale page degrades instead of throwing.

### Pass 4 — attempt identity (§6) — DONE

**The open decision was resolved as option 1, and the two options turned out not to be exclusive.**
Attempts are now teacher-allowed per assessment via `max_attempts` (default 1, enforced in the
rules), *and* the deterministic document id stays — because attempt 1 keeps the legacy id
`{quizId}__{rollNo}` with no suffix, and only attempts 2+ get a `__a{n}` suffix. So for the default
`max_attempts: 1` the behaviour is byte-identical to before this pass: one attempt, structurally
guaranteed by the document id, same ids, no migration. The anti-resubmission property section E
called out as "a real anti-cheat property" is not traded away; it becomes the default rather than a
law of the schema, and loosening it is an explicit per-assessment act by the teacher.

- **New:** `tests/attempt-identity.test.js` (17 checks, run in a VM sandbox against the real
  shipped browser modules with only `firebase`/`localStorage`/`navigator` stubbed).
- **Changed:** `js/firestore-client.js`, `js/submission-sync.js`, `js/dashboard.js`, `js/export.js`,
  `student.html`, `firestore.rules`.
- Section E's entity gaps are closed: `assessment_id`, `subject_id`, `unit_id`, `attempt_id`,
  `attemptNumber` and `maxAttempts` are on every submission, alongside the legacy `quizId`/`unit`
  rather than replacing them, so the dashboard's existing filters keep working.
- The rules bind the document id to `attemptNumber` in both directions, so a student cannot park a
  resubmission at an id of their own invention. For attempt >1 the cap is read from the live
  `assessments/{id}` document, so it is server-enforced, not client-trusted — and attempt 1 never
  reaches that `get()`, so the common path costs no extra read.
- The dashboard gained an Attempt column and the CSV export gained Attempt / Max Attempts /
  Assessment ID. A submission predating attempts reports "1", which is accurate by construction
  rather than a guess.

**Production bug found and fixed during Pass 4.** `saveSubmission()` used `set()`, and Firestore
evaluates `set()` over an *existing* document as an `update` — which `firestore.rules` allows only
for the teacher. So a blocked resubmission has always come back `permission-denied`, never
`already-exists`. `js/submission-sync.js` tested only for `already-exists` (the web SDK has no
`create()`, so that code never fires), which meant **every re-taken quiz left a poison entry in the
student's `localStorage` pending queue — replayed on every page load, for the life of the device,
never able to succeed.** The student was also shown "will finish sending automatically", which was
never true. Both fixed; the refusal is now terminal, and the results screen says plainly that the
attempt was not recorded. Covered by a regression test.

A second, subtler hazard was designed out rather than discovered in the wild: because
`withTimeout()` deliberately does not cancel the underlying write, a timed-out write can still land
later. Had the queued replay *searched* for a free attempt slot the way a fresh submit does, a
student who sat a 3-attempt quiz once would have ended up with two attempts on file. The slot is
therefore pinned into the queued document at submit time and the replay writes only that slot. Also
regression-tested.

### Still outstanding

Items 6–8 of section H: the teacher material/review UI, the student assessment picker, and all of
the section G security hardening. **None of the section G weaknesses have been addressed yet** — the
config is still student-editable, the timer still client-trusted, the answer key still ships with
the paper.

**Second bug found while verifying Pass 4.** Pass 1 noted that `questionValidator.js` and
`duplicateChecker.js` were `<script>`-loaded by `teacher.html` but never precached, "so the bank
editor was silently broken offline" — and precached those two. It precached the editor's
*dependencies* but not `js/bank-editor.js` itself, so the editor was still broken offline, on the
very next line of the same `<script>` block. Now precached, with `CACHE_VERSION` bumped to `v3` as
that file's own maintenance note requires. A mechanical check (every non-CDN `<script src>` on all
four pages appears in `PRECACHE_URLS`) now passes for the first time; it is worth re-running after
any page edit, since nothing enforces that list.

Two follow-ups this pass created rather than closed:

1. **Multiple attempts need the registry mirrored into Firestore.** The rules read
   `assessments/{id}.max_attempts`, and nothing writes that collection yet — the registry is still
   file-backed (`data/assessments.json`, read server-side by `lib/registryStore.js`). Until
   `api/assessments.js` (item 6) exists, setting `max_attempts > 1` in the JSON will be refused at
   write time. That is the safe default, not a silent failure, but it is a real gap between what the
   schema allows and what the deployment accepts.
2. **The attempt cap is enforced at submit time, not at start time.** A student can re-open a
   one-attempt quiz and sit it again; they are told at submission that it will not be recorded.
   Blocking the start needs a server-issued attempt token, which belongs with the section G work.

### Deployment note (Pass 4)

`firestore.rules` now requires the new identity keys on every submission create. Deploy the rules
and the updated client together — rules first is safe (a submission from the old client would be
refused and queued, then accepted on the student's next load once the new client is served), client
first is not (new keys the old rules do not expect are *not* refused, so this ordering merely delays
enforcement rather than breaking anything, but it leaves a window where the cap is unenforced).

```
firebase deploy --only firestore:rules
```

### Deployment note

`storage.rules` is new and must be deployed before the first upload — the bucket has never been
written to, so it has no rules of its own yet:

```
firebase deploy --only storage,firestore:rules
```
