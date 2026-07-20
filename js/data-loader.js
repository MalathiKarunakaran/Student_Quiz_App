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

  return { fetchJSON, resolveConfig, loadQuestionBank, encodeConfigToBase64 };
})();
