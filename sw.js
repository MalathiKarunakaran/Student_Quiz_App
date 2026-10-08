/**
 * sw.js — Service Worker (offline support)
 * ---------------------------------------------------------------------------
 * Why this exists: many students take these quizzes on phones/laptops with
 * unreliable campus Wi-Fi. Before this file, a dropped connection mid-quiz
 * meant a blank page on any reload and no way to resume — the answers were
 * safe in localStorage (js/storage.js), but the *app itself* was gone.
 *
 * THE ONE DESIGN CONSTRAINT THAT SHAPES EVERYTHING BELOW
 * -----------------------------------------------------
 * README §1 defends a specific property of this codebase: the instructor can
 * edit a `.js` or `data/*.json` file directly in the GitHub web UI and it
 * takes effect on the next page load, with no build step. A naive
 * cache-first service worker silently destroys that property — the instructor
 * edits a question bank, reloads, and sees the old one, with no obvious cause.
 *
 * So same-origin requests use NETWORK-FIRST with a short timeout, not
 * cache-first:
 *   - Online  → always the live file. The GitHub-UI-edit property is fully
 *               preserved, and a student never sees a stale question bank.
 *   - Offline → the precached copy, so the quiz still opens and runs.
 *   - Slow/flaky Wi-Fi → after NETWORK_TIMEOUT_MS the cached copy is served
 *               immediately so a timed quiz isn't stalled by a hanging
 *               request, while the real response still finishes in the
 *               background and refreshes the cache for next time.
 *
 * Cross-origin CDN assets are the opposite case and use CACHE-FIRST, because
 * every one of them is version-pinned in its URL (firebasejs/10.13.2/...,
 * pyodide/v0.26.4/..., jspdf@2.5.1/...) and therefore immutable — a cached
 * copy can never go stale, and re-downloading Pyodide (tens of MB) on every
 * run would be far worse than the staleness risk, which is zero.
 *
 * NOT intercepted at all: `/api/*` (serverless, always needs the network and
 * is POST anyway) and Firestore's own googleapis.com traffic (the Firestore
 * SDK runs its own offline queue; a service worker sitting in front of it
 * would only interfere).
 *
 * MAINTENANCE: PRECACHE_URLS below is a hand-written list, because there is
 * no build step to generate it. If you add a new .js/.json/.html/image file
 * that the app needs offline, add it here AND bump CACHE_VERSION. Bumping the
 * version is what makes browsers install the new worker and re-precache.
 * ---------------------------------------------------------------------------
 */

const CACHE_VERSION = "v3";
const PRECACHE = `csa65-precache-${CACHE_VERSION}`;
const RUNTIME = `csa65-runtime-${CACHE_VERSION}`;

/** How long to wait for the network before falling back to cache (ms). */
const NETWORK_TIMEOUT_MS = 4000;

/** Sentinel for "the network lost the race" — distinct from any real Response. */
const TIMED_OUT = Symbol("timed-out");

/**
 * Same-origin files needed for a fully offline quiz attempt. Paths are
 * relative to this worker's own location, so the app works unchanged at a
 * domain root (`vercel.app/`) and in a GitHub Pages subpath
 * (`/Student_Quiz_App/`) without any configured base URL.
 */
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./student.html",
  "./teacher.html",
  "./dashboard.html",
  "./offline.html",
  "./manifest.webmanifest",

  "./css/style.css",

  "./js/auth-guard.js",
  // The bank editor's DEPENDENCIES were precached when the registry landed, but
  // the editor module itself was not — so teacher.html still threw on
  // `BankEditor` offline. Same class of omission, one file further along.
  "./js/bank-editor.js",
  "./js/code-runner.js",
  "./js/dashboard.js",
  "./js/data-loader.js",
  "./js/export.js",
  "./js/firebase-config.js",
  "./js/firestore-client.js",
  "./js/integrity.js",
  "./js/open-ended-grader.js",
  "./js/pdf-report.js",
  "./js/question-renderer.js",
  "./js/quiz-engine.js",
  "./js/randomizer.js",
  "./js/scorer.js",
  "./js/storage.js",
  "./js/submission-sync.js",
  "./js/sw-register.js",
  "./js/teacher-config.js",
  "./js/theme.js",
  "./js/timer.js",

  // Dual-mode lib/ modules loaded directly by the pages (CommonJS in Node,
  // globals in the browser). questionValidator/duplicateChecker were already
  // <script>-loaded by teacher.html but never precached, so the editor broke
  // offline; assessmentRegistry is new and student.html depends on it.
  "./lib/assessmentRegistry.js",
  "./lib/questionValidator.js",
  "./lib/duplicateChecker.js",

  "./data/assessments.json",
  "./data/questions-unit1.json",
  "./data/config-unit1-quiz1.json",

  "./assets/img/simats-logo.png",
  "./assets/img/sse-logo.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/favicon-32.png",
];

/**
 * Cross-origin assets worth precaching: the Firebase compat SDKs that
 * student.html loads. If these are missing offline, `firebase` is undefined
 * and the submission sync throws — SubmissionSync.sync() catches that and
 * queues the result for retry, so nothing is lost either way. Caching them
 * buys something better though: a student who starts offline but is back
 * online by the time they submit gets a real, immediate sync instead of a
 * queued one.
 *
 * These are fetched with `mode: "no-cors"` (yielding opaque responses) rather
 * than via cache.addAll(), because addAll() uses CORS mode and rejects the
 * entire batch if any single entry fails. A classic `<script src>` load is a
 * no-cors request, so an opaque cached response replays correctly for it.
 */
const PRECACHE_OPAQUE_URLS = [
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js",
];

/**
 * Cross-origin hosts whose responses are safe to cache-first on demand.
 * Everything here is either version-pinned (immutable) or a font file.
 */
const CDN_HOSTS = [
  "www.gstatic.com",        // Firebase SDKs (version-pinned)
  "cdn.jsdelivr.net",       // Pyodide + jsPDF (version-pinned)
  "fonts.googleapis.com",   // Google Fonts stylesheet
  "fonts.gstatic.com",      // Google Fonts woff2 files
];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);

    // Individually, not addAll(): one 404 from a file an instructor happened
    // to rename should degrade that single entry, not abort the whole install
    // and leave the app with no offline support at all.
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: "reload" }));
        if (res.ok) await cache.put(url, res);
      } catch (e) { /* offline during install, or file missing — skip it */ }
    }));

    await Promise.all(PRECACHE_OPAQUE_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { mode: "no-cors" }));
        // An opaque response has status 0; that is a success here, not a failure.
        await cache.put(url, res);
      } catch (e) { /* CDN unreachable — the app degrades gracefully without it */ }
    }));
  })());

  // Deliberately NOT calling skipWaiting(): a student may be mid-quiz in a
  // controlled page right now, and swapping the worker underneath them is not
  // worth it. The new version activates once every tab is closed, or when the
  // page explicitly posts SKIP_WAITING (js/sw-register.js only does that from
  // a user-initiated "Reload" on a page with no quiz in progress).
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith("csa65-") && k !== PRECACHE && k !== RUNTIME)
          .map(k => caches.delete(k))
    );
    // Take over already-open tabs so the very first visit gets offline
    // support without needing a reload.
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Fetch strategies
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only GET is cacheable, and only GET is safe to replay. Submissions,
  // /api/* calls and Firestore writes all fall through to the network here.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Serverless endpoints have no meaningful offline representation.
    if (url.pathname.includes("/api/")) return;
    event.respondWith(networkFirst(req));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Everything else (notably firestore.googleapis.com) is left entirely
  // alone — the Firestore SDK manages its own connection and retry logic.
});

/**
 * Network-first with a timeout, falling back to cache.
 *
 * The timeout only decides *what to show now*; the real network request is
 * never cancelled, so it still lands in the cache for the next load. That
 * matters on exactly the connection this feature exists for: a 20-second
 * campus Wi-Fi stall shouldn't freeze a timed quiz, but it also shouldn't
 * throw away the response that eventually arrives.
 */
async function networkFirst(request) {
  const cache = await caches.open(PRECACHE);

  const networkPromise = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  });
  // Without this, a network rejection that loses the race below surfaces as
  // an unhandled promise rejection in the worker.
  networkPromise.catch(() => {});

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve(TIMED_OUT), NETWORK_TIMEOUT_MS);
  });

  let result;
  try {
    result = await Promise.race([networkPromise, timeoutPromise]);
  } catch (e) {
    result = TIMED_OUT; // genuinely offline — fall through to the cache
  }
  if (result !== TIMED_OUT) return result;

  const cached = await matchCached(request);
  if (cached) return cached;

  // Nothing cached. If the network is merely slow rather than down, waiting
  // it out is still better than failing.
  try {
    return await networkPromise;
  } catch (e) {
    if (request.mode === "navigate") {
      const fallback = await caches.match("./offline.html");
      if (fallback) return fallback;
    }
    return new Response("Offline and this resource was never cached.", {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/**
 * Cache lookup that is tolerant of two things the plain `caches.match(request)`
 * would miss:
 *   1. Query strings. A student's shareable link is
 *      `student.html?config=<base64>`, and every such link is a unique URL —
 *      none of which can be precached. `ignoreSearch` lets all of them resolve
 *      to the one cached `student.html`, which is correct here because the
 *      config is parsed from `window.location` by the page itself, not by the
 *      server (js/data-loader.js resolveConfig()).
 *   2. `cache: "no-store"` requests. js/data-loader.js fetches every JSON file
 *      with `{ cache: "no-store" }`; matching on the URL rather than the
 *      Request object sidesteps any header/mode mismatch.
 */
async function matchCached(request) {
  const direct = await caches.match(request, { ignoreSearch: true });
  if (direct) return direct;

  const url = new URL(request.url);
  // Directory-style navigation ("/Student_Quiz_App/") → the cached index.
  if (request.mode === "navigate" && url.pathname.endsWith("/")) {
    return caches.match("./index.html");
  }
  return undefined;
}

/** Cache-first, for immutable version-pinned CDN assets. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    // Opaque responses (status 0) are expected for no-cors script/font loads
    // and must still be cached — that's the whole point for Pyodide/jsPDF.
    if (res && (res.ok || res.type === "opaque")) {
      const cache = await caches.open(RUNTIME);
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    // Offline and never fetched before. Let the caller's own error handling
    // take over — code-runner.js and pdf-report.js both already degrade
    // gracefully when their CDN is unreachable (README §23, §25).
    throw e;
  }
}
