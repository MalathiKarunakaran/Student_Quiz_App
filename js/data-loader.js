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

  /**
   * Resolves the active quiz config from (in priority order):
   *   1. ?config=<base64 JSON>   — fully self-contained shareable link
   *   2. ?configFile=<path>      — path to a committed config JSON in the repo
   *   3. fallback default path   — data/config-unit1-quiz1.json
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

    const path = params.get("configFile") || defaultPath;
    return fetchJSON(path);
  }

  async function loadQuestionBank(path) {
    const data = await fetchJSON(path);
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

  return { fetchJSON, resolveConfig, loadQuestionBank, encodeConfigToBase64, generateQuestions, generateKeywords };
})();
