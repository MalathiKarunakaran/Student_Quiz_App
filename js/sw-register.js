/**
 * sw-register.js
 * ---------------------------------------------------------------------------
 * Registers sw.js and owns the two bits of UI that a service worker needs:
 * a one-time "ready to work offline" confirmation, and an update prompt.
 *
 * Why the update prompt is a prompt and not an automatic reload: sw.js
 * deliberately does NOT call skipWaiting(), because a student could be
 * mid-quiz in a controlled tab, and silently swapping the worker (then
 * reloading to pick it up) would interrupt a timed attempt. So a new version
 * sits in `waiting` until either every tab closes, or the user accepts the
 * prompt here — and student.html suppresses the prompt entirely while a quiz
 * is in progress, via the `canPrompt` option.
 *
 * Registration is skipped silently on `file://` and on insecure origins,
 * where the Service Worker API is unavailable by design. Everything in this
 * module is additive: if registration fails for any reason, the app behaves
 * exactly as it did before offline support existed.
 * ---------------------------------------------------------------------------
 */

const SWRegister = (() => {
  const SEEN_OFFLINE_READY_KEY = "csa65swofflineready";

  let registration = null;
  let options = {};
  /** True only once the user has accepted an update prompt — see controllerchange below. */
  let acceptedUpdate = false;
  let reloading = false;

  function isSupported() {
    // `isSecureContext` is true for https and for localhost, and false for
    // file:// — which is exactly the set of origins where registration works.
    return "serviceWorker" in navigator && window.isSecureContext;
  }

  /**
   * options:
   *   canPrompt   fn -> boolean. Return false to suppress the update prompt
   *               right now (student.html returns false during a quiz).
   *               Defaults to always allowing it.
   *   showOfflineReady  boolean. Show the one-time "works offline now" note.
   *               Defaults to true.
   */
  function init(opts = {}) {
    options = { canPrompt: () => true, showOfflineReady: true, ...opts };
    if (!isSupported()) return;

    // Registering after `load` keeps the worker install off the critical path
    // for the first paint — it costs nothing to defer, and precaching a few
    // hundred KB shouldn't compete with rendering the quiz.
    window.addEventListener("load", async () => {
      try {
        registration = await navigator.serviceWorker.register("sw.js");
      } catch (e) {
        return; // Offline support simply doesn't engage; the app is unaffected.
      }

      // A worker already waiting when the page loads (user closed and
      // reopened without ever accepting a previous prompt).
      if (registration.waiting && navigator.serviceWorker.controller) {
        offerUpdate();
      }

      registration.addEventListener("updatefound", () => {
        const incoming = registration.installing;
        if (!incoming) return;
        incoming.addEventListener("statechange", () => {
          if (incoming.state !== "installed") return;
          if (navigator.serviceWorker.controller) {
            // There was a previous worker → this is an update, not a first install.
            offerUpdate();
          } else {
            noteOfflineReady();
          }
        });
      });
    });

    // Fires once the waiting worker takes over after SKIP_WAITING. Reloading
    // here (rather than immediately on click) guarantees the new worker is
    // actually in control of the page being reloaded.
    //
    // The `acceptedUpdate` guard is essential, not defensive: sw.js calls
    // clients.claim() on activate, which ALSO fires controllerchange — on the
    // very first install, for a page that was previously uncontrolled.
    // Reloading on that one would make every first-ever visit silently reload
    // itself, wiping anything the student had already typed into the entry
    // form. Only a reload the user actually asked for should happen here.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!acceptedUpdate || reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  /** One-time, low-key confirmation that the app is now usable offline. */
  function noteOfflineReady() {
    if (!options.showOfflineReady) return;
    try {
      if (localStorage.getItem(SEEN_OFFLINE_READY_KEY)) return;
      localStorage.setItem(SEEN_OFFLINE_READY_KEY, "1");
    } catch (e) { /* localStorage unavailable — show it anyway, harmlessly */ }

    showToast({
      message: "Saved for offline use. This quiz app will now open even without a connection.",
      dismissLabel: "Got it",
    });
  }

  function offerUpdate() {
    if (!options.canPrompt()) return;
    showToast({
      message: "A new version of the quiz app is available.",
      actionLabel: "Reload",
      dismissLabel: "Later",
      onAction: () => {
        acceptedUpdate = true;
        if (registration && registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
          // The reload happens in the controllerchange handler above.
        } else {
          window.location.reload();
        }
      },
    });
  }

  /**
   * Minimal toast. Built here rather than added to every page's markup so that
   * adding offline support meant one `<script>` line per page and no HTML
   * churn across four files.
   */
  function showToast({ message, actionLabel, dismissLabel, onAction }) {
    const existing = document.getElementById("swToast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "swToast";
    toast.className = "sw-toast";
    toast.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "sw-toast-text";
    text.textContent = message;
    toast.appendChild(text);

    if (actionLabel) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "sw-toast-btn sw-toast-btn--action";
      action.textContent = actionLabel;
      action.addEventListener("click", () => {
        toast.remove();
        if (onAction) onAction();
      });
      toast.appendChild(action);
    }

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "sw-toast-btn";
    dismiss.textContent = dismissLabel || "Dismiss";
    dismiss.addEventListener("click", () => toast.remove());
    toast.appendChild(dismiss);

    document.body.appendChild(toast);
  }

  return { init, isSupported };
})();
