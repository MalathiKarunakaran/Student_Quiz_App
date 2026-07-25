/**
 * integrity.js
 * ---------------------------------------------------------------------------
 * Exam-lockdown measures for the student quiz screen: mandatory fullscreen,
 * detection of fullscreen-exit/tab-switch/minimize/window-blur, and blocking
 * of copy/cut/paste/right-click/drag/text-selection/common devtools-and-print
 * keyboard shortcuts.
 *
 * HONEST LIMITATION (documented, not hidden — see README "Security &
 * Limitations"): this is all client-side JavaScript running in a static,
 * no-backend app. A technically sophisticated student can always defeat any
 * client-side check (disable JS, use browser devtools protocol, a second
 * physical device, etc). These guards raise the effort bar and give the
 * instructor visibility via the violation log — they are NOT a substitute for
 * physical proctoring in a high-stakes exam. Some things plain JS categorically
 * cannot intercept at all: OS-level Alt+Tab / Cmd+Tab window switching (still
 * caught indirectly via the resulting blur/visibilitychange), the PrintScreen
 * key, and a second device pointed at the screen.
 *
 * Violation de-duplication: switching tabs/minimizing normally fires BOTH
 * `visibilitychange` and `blur` together. Counting both would double-log a
 * single real event, so `blur` is only treated as its own violation when the
 * document is NOT already hidden — i.e. a focus loss that visibilitychange
 * didn't already capture (e.g. devtools undocked into its own window, or an
 * OS window switch that doesn't hide the tab in some browsers).
 * ---------------------------------------------------------------------------
 */

const IntegrityGuard = (() => {
  let active = false;
  let onViolation = null;
  let blockedKeyHandler = null;
  let contextMenuHandler = null;
  let copyCutPasteHandler = null;
  let dragHandler = null;
  let selectStartHandler = null;
  let visibilityHandler = null;
  let blurHandler = null;
  let fullscreenHandler = null;

  function isFullscreenSupported() {
    return !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /** Must be called from a direct user-gesture handler (e.g. a button onclick). */
  function requestFullscreen(el) {
    const target = el || document.documentElement;
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!req) return Promise.reject(new Error("Fullscreen is not supported in this browser."));
    return req.call(target).catch(() => {
      throw new Error("Fullscreen was blocked or dismissed. Please allow fullscreen to start the quiz.");
    });
  }

  function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit && isFullscreen()) exit.call(document);
  }

  const BLOCKED_KEY_COMBOS = [
    { ctrlOrMeta: true, key: "c" },       // copy
    { ctrlOrMeta: true, key: "v" },       // paste
    { ctrlOrMeta: true, key: "x" },       // cut
    { ctrlOrMeta: true, key: "p" },       // print
    { ctrlOrMeta: true, key: "s" },       // save page
    { ctrlOrMeta: true, key: "u" },       // view source
    { ctrlOrMeta: true, shift: true, key: "i" },  // devtools
    { ctrlOrMeta: true, shift: true, key: "j" },  // devtools console
    { ctrlOrMeta: true, shift: true, key: "c" },  // devtools inspector
    { key: "f12" },                       // devtools
  ];

  function matchesBlockedCombo(e) {
    const key = (e.key || "").toLowerCase();
    return BLOCKED_KEY_COMBOS.some(combo => {
      if (combo.ctrlOrMeta && !(e.ctrlKey || e.metaKey)) return false;
      if (combo.shift && !e.shiftKey) return false;
      return combo.key === key;
    });
  }

  let lastViolationAt = 0;
  function fireViolation(type) {
    const now = Date.now();
    if (now - lastViolationAt < 250) return; // de-dupe near-simultaneous browser events
    lastViolationAt = now;
    if (onViolation) onViolation(type);
  }

  /**
   * @param {object} opts
   *   onViolation(type) — called with 'tabswitch' | 'windowblur' | 'fullscreenexit'
   *   onPasteBlocked(target) — optional, called with the input/textarea a
   *     blocked paste/copy/cut was attempted on, for a visual "blocked" flash
   */
  function enable(opts) {
    if (active) return;
    active = true;
    onViolation = opts.onViolation || null;

    blockedKeyHandler = (e) => {
      if (matchesBlockedCombo(e)) e.preventDefault();
    };
    document.addEventListener("keydown", blockedKeyHandler, true);

    contextMenuHandler = (e) => e.preventDefault();
    document.addEventListener("contextmenu", contextMenuHandler, true);

    copyCutPasteHandler = (e) => {
      e.preventDefault();
      const tag = (e.target && e.target.tagName) || "";
      if (opts.onPasteBlocked && (tag === "INPUT" || tag === "TEXTAREA")) opts.onPasteBlocked(e.target);
    };
    document.addEventListener("copy", copyCutPasteHandler, true);
    document.addEventListener("cut", copyCutPasteHandler, true);
    document.addEventListener("paste", copyCutPasteHandler, true);

    dragHandler = (e) => e.preventDefault();
    document.addEventListener("dragstart", dragHandler, true);

    selectStartHandler = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
    };
    document.addEventListener("selectstart", selectStartHandler, true);

    visibilityHandler = () => {
      if (document.hidden) fireViolation("tabswitch");
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    blurHandler = () => {
      if (!document.hidden) fireViolation("windowblur");
    };
    window.addEventListener("blur", blurHandler);

    fullscreenHandler = () => {
      if (!isFullscreen()) fireViolation("fullscreenexit");
    };
    document.addEventListener("fullscreenchange", fullscreenHandler);
    document.addEventListener("webkitfullscreenchange", fullscreenHandler);
  }

  function disable() {
    if (!active) return;
    active = false;
    document.removeEventListener("keydown", blockedKeyHandler, true);
    document.removeEventListener("contextmenu", contextMenuHandler, true);
    document.removeEventListener("copy", copyCutPasteHandler, true);
    document.removeEventListener("cut", copyCutPasteHandler, true);
    document.removeEventListener("paste", copyCutPasteHandler, true);
    document.removeEventListener("dragstart", dragHandler, true);
    document.removeEventListener("selectstart", selectStartHandler, true);
    document.removeEventListener("visibilitychange", visibilityHandler);
    window.removeEventListener("blur", blurHandler);
    document.removeEventListener("fullscreenchange", fullscreenHandler);
    document.removeEventListener("webkitfullscreenchange", fullscreenHandler);
  }

  return { isFullscreenSupported, isFullscreen, requestFullscreen, exitFullscreen, enable, disable };
})();
