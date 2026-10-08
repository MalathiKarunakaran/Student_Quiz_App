/**
 * data-loader.js
 * ---------------------------------------------------------------------------
 * Loads question banks and quiz configuration from JSON files (or from a
 * base64-encoded config embedded directly in the URL, for the "zero repo
 * commits per quiz" sharing workflow — see README "Teacher Workflow").
 * ---------------------------------------------------------------------------
 */

const DataLoader = (() => {

  async function fetchJSON(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Assessment registry (docs/AUDIT.md section H, item 1)
  // ---------------------------------------------------------------------------

  const REGISTRY_PATH = "data/assessments.json";
  let registryCache = null;

  /**
   * Loads the Subject → Unit → Topic → Assessment registry.
   *
   * Static JSON for now, which is deliberate: it keeps the registry working on
   * plain GitHub Pages with no backend, exactly like the question banks it sits
   * beside. When the teacher panel starts writing assessments to Firestore this
   * becomes the fallback rather than the only source — the same two-tier shape
   * loadBank() already uses for "firestore:<bankId>" vs a repo path.
   *
   * Cached per page load: resolveConfig() and any assessment picker on the same
   * page would otherwise each refetch it.
   */
  async function loadRegistry(force = false) {
    if (registryCache && !force) return registryCache;
    registryCache = await fetchJSON(REGISTRY_PATH);
    return registryCache;
  }

  /** Published assessments only — never call listAssessments() from student-facing code. */
  async function listPublishedAssessments(filters = {}) {
    const registry = await loadRegistry();
    return AssessmentRegistry.listPublishedAssessments(registry, filters);
  }

  /**
   * Resolves a single assessment id into the legacy quiz-config shape the rest
   * of the pipeline consumes. Refuses anything not published, so a draft or
   * under-review assessment can never be opened by guessing its id (§8).
   */
  async function configFromAssessmentId(assessmentId) {
    const registry = await loadRegistry();
    const entry = AssessmentRegistry.findAssessment(registry, assessmentId);
    if (!entry) {
      throw new Error(`No assessment named "${assessmentId}" exists.`);
    }
    if (entry.assessment.status !== "published") {
      // Deliberately the same message as the not-found case above: telling an
      // unauthenticated visitor that an id exists but is still a draft leaks
      // the existence and timing of unreleased assessments.
      throw new Error(`No assessment named "${assessmentId}" exists.`);
    }
    return AssessmentRegistry.toQuizConfig(entry);
  }

  /**
   * Resolves the active quiz config from (in priority order):
   *   1. ?config=<base64 JSON>   — fully self-contained shareable link
   *   2. ?assessment=<id>        — registry lookup (the new, preferred form)
   *   3. ?configFile=<path>      — path to a committed config JSON in the repo
   *   4. fallback default path   — data/config-unit1-quiz1.json
   *
   * 1, 3 and 4 are retained unchanged for backward compatibility (§12): every
   * link already handed to a student keeps working. New links should use
   * ?assessment=, which is both shorter and — unlike the base64 config — not
   * editable by the student holding it (docs/AUDIT.md section G, item 1).
   */
  async function resolveConfig(defaultPath = "data/config-unit1-quiz1.json") {
    const params = new URLSearchParams(window.location.search);

    if (params.has("config")) {
      try {
        const decoded = decodeURIComponent(escape(atob(params.get("config"))));
        return JSON.parse(decoded);
      } catch (e) {
        throw new Error("Could not parse the 'config' URL parameter — the link may be corrupted.");
      }
    }

    if (params.has("assessment")) {
      return configFromAssessmentId(params.get("assessment").trim());
    }

    const path = params.get("configFile") || defaultPath;
    return fetchJSON(path);
  }

  /**
   * A bank reference is either a repo-relative JSON path
   * (`data/questions-unit1.json`) or a Firestore bank id written as
   * `firestore:<bankId>` (README Section 30).
   *
   * One string rather than a separate "source" config field, because this
   * value already flows through three places that would each have needed a
   * parallel change — the teacher panel's input, the base64 config in a
   * shareable link, and every committed `config-*.json`. Existing links and
   * config files keep working untouched: anything without the prefix is still
   * a path.
   */
  const FIRESTORE_PREFIX = "firestore:";

  function isFirestoreRef(ref) {
    return typeof ref === "string" && ref.startsWith(FIRESTORE_PREFIX);
  }

  function firestoreBankId(ref) {
    return String(ref).slice(FIRESTORE_PREFIX.length).trim();
  }

  /** Returns the full bank object ({ unit, unitTitle, questions }). */
  async function loadBank(ref) {
    if (!isFirestoreRef(ref)) return fetchJSON(ref);

    const bankId = firestoreBankId(ref);
    if (!bankId) throw new Error(`"${ref}" is missing a bank id after "${FIRESTORE_PREFIX}".`);
    if (typeof FirebaseApp === "undefined" || !FirebaseApp.isConfigured()) {
      throw new Error(
        `This quiz loads its questions from Firestore ("${bankId}"), but Firebase isn't ` +
        `configured in this deployment. See docs/firebase-setup.md.`
      );
    }
    return FirestoreClient.loadQuestionBank(bankId);
  }

  async function loadQuestionBank(ref) {
    const data = await loadBank(ref);
    return data.questions || [];
  }

  /** Encodes a config object into a URL-safe base64 string for shareable links. */
  function encodeConfigToBase64(configObj) {
    const json = JSON.stringify(configObj);
    return btoa(unescape(encodeURIComponent(json)));
  }

  /**
   * Calls the Hermes Agent's serverless endpoint (/api/generate-questions) to
   * generate new questions with an LLM. Only works on a Vercel deployment.
   * On any plain static host (GitHub Pages, a local `python -m http.server`,
   * etc.) there's no server behind this path at all, so the response is some
   * host-specific HTML/plaintext error page rather than JSON — that's the
   * reliable signal used here (not a specific status code, since different
   * static hosts return different codes for an unsupported POST: e.g. 404,
   * 405, or Python's dev server's 501) to show a clear, actionable message
   * instead of a raw fetch failure.
   */
  async function generateQuestions(payload) {
    let res;
    try {
      res = await fetch("/api/generate-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error("Could not reach the AI generation service (network error).");
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error(
        "AI question generation isn't available on this static hosting (no server). " +
        "Open this app from its Vercel deployment to use 'Generate with AI'."
      );
    }

    if (!res.ok) {
      throw new Error(body?.error || `AI generation failed (HTTP ${res.status}).`);
    }
    return body;
  }

  /**
   * Calls the teacher-only keyword-bank generation endpoint
   * (/api/generate-keywords). Only works on a Vercel deployment, same
   * static-hosting caveat as generateQuestions() above. idToken is the
   * signed-in teacher's Firebase ID token (see js/auth-guard.js getIdToken()).
   */
  async function generateKeywords(payload, idToken) {
    let res;
    try {
      res = await fetch("/api/generate-keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error("Could not reach the keyword-bank generation service (network error).");
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error(
        "Keyword-bank generation isn't available on this static hosting (no server). " +
        "Open this app from its Vercel deployment to use 'Generate Keyword Bank'."
      );
    }

    if (!res.ok) {
      throw new Error(body?.error || `Keyword-bank generation failed (HTTP ${res.status}).`);
    }
    return body;
  }

  return {
    fetchJSON, resolveConfig, loadQuestionBank, loadBank, encodeConfigToBase64,
    generateQuestions, generateKeywords, isFirestoreRef, firestoreBankId, FIRESTORE_PREFIX,
    loadRegistry, listPublishedAssessments, configFromAssessmentId, REGISTRY_PATH,
  };
})();
