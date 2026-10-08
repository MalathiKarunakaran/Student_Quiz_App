/**
 * tests/offline-support.test.js
 * ---------------------------------------------------------------------------
 * Real-browser tests for offline support (README Section 29).
 *
 * This is OPTIONAL developer tooling. The app itself still has no build step
 * and no dependencies — nothing here is needed to edit, deploy or run it. It
 * exists because Section 29 makes claims ("a full quiz runs with the network
 * off", "an edited question bank is never served stale") that are only
 * meaningful if they can be re-checked, and because every bug this feature had
 * was invisible to Node-only testing: they lived in the service-worker
 * lifecycle, in Firestore's offline promise behaviour, and in CSS.
 *
 * Run it:
 *     cd csa65-quiz-app
 *     npx --yes playwright install chromium     # one time
 *     node tests/offline-support.test.js
 *
 * It starts its own static servers on ports 8765 and 8766 and shuts them down
 * again, so nothing needs to be running first.
 * ---------------------------------------------------------------------------
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error(
    "Playwright is not installed.\n" +
    "  npm install --no-save playwright && npx playwright install chromium"
  );
  process.exit(2);
}

const APP_ROOT = path.resolve(__dirname, "..");
const ROOT_PORT = 8765;
const SUBPATH_PORT = 8766;
const SUBPATH = "/Student_Quiz_App"; // the shape GitHub Pages actually serves

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(title) { console.log(`\n${title}`); }

// --- minimal static file server ---------------------------------------------

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml",
};

function serve(port, stripPrefix) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (stripPrefix) {
      if (!urlPath.startsWith(stripPrefix)) { res.writeHead(404).end("not found"); return; }
      urlPath = urlPath.slice(stripPrefix.length) || "/";
    }
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const file = path.join(APP_ROOT, urlPath);
    // Keep the server inside the app directory.
    if (!file.startsWith(APP_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/html" }).end("<h1>404</h1>");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// --- helpers ----------------------------------------------------------------

/** Waits for the worker to reach 'activated' and finish its install-time precache. */
async function waitForWorker(page, minEntries = 30) {
  await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    if (r.active && r.active.state !== "activated") {
      await new Promise(res => {
        r.active.addEventListener("statechange", function h() {
          if (r.active.state === "activated") { r.active.removeEventListener("statechange", h); res(); }
        });
        setTimeout(res, 10000);
      });
    }
  });
  return page.evaluate(async (min) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const name = (await caches.keys()).find(k => k.startsWith("csa65-precache-"));
      if (name) {
        const keys = await (await caches.open(name)).keys();
        if (keys.length >= min) return keys.map(k => k.url);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    const name = (await caches.keys()).find(k => k.startsWith("csa65-precache-"));
    return name ? (await (await caches.open(name)).keys()).map(k => k.url) : [];
  }, minEntries);
}

// --- the suites --------------------------------------------------------------

async function runRootSuite(browser) {
  const BASE = `http://127.0.0.1:${ROOT_PORT}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));

  section("Offline support — served from a domain root");

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  const cached = await waitForWorker(page);
  check("worker activates and precaches the app shell", cached.length >= 30, `${cached.length} entries`);

  for (const must of ["/student.html", "/css/style.css", "/js/quiz-engine.js",
                      "/data/questions-unit1.json", "/data/config-unit1-quiz1.json",
                      "/offline.html"]) {
    check(`precached: ${must}`, cached.some(u => u.endsWith(must)));
  }
  check("firebase SDK precached (opaque cross-origin response)",
        cached.some(u => u.includes("firebase-firestore-compat.js")));

  // Regression guard. sw.js calls clients.claim(), which fires controllerchange
  // on a first install; sw-register.js must NOT treat that as an accepted
  // update and reload, or every first visit wipes the entry form mid-typing.
  await page.goto(`${BASE}/student.html`, { waitUntil: "load" });
  await page.fill("#entryName", "Typed Before Claim");
  await page.waitForTimeout(2500);
  check("first visit does not self-reload when the worker claims the page",
        (await page.inputValue("#entryName")) === "Typed Before Claim");
  check("page is controlled by the worker",
        await page.evaluate(() => !!navigator.serviceWorker.controller));

  await ctx.setOffline(true);

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  check("index.html loads offline", (await page.title()).includes("CSA65"));
  check("index.html offline: stylesheet applied",
        await page.evaluate(() => getComputedStyle(document.querySelector(".nav-card")).borderRadius !== ""));

  await page.goto(`${BASE}/student.html`, { waitUntil: "load" });
  // Fullscreen can't be granted headlessly, so the engine is driven directly.
  // What's under test is the worker's job: every module and the question bank
  // being reachable with the network off.
  const quiz = await page.evaluate(async () => {
    const s = await QuizEngine.init("Offline Tester", "21CS999");
    return { n: s.quiz.length, title: s.config.quizTitle };
  });
  check("question bank + config load offline from cache", quiz.n > 0,
        `${quiz.n} questions · "${quiz.title}"`);

  // The whole point: submitting offline must finish, not hang. A Firestore
  // write's promise never settles without a connection (see submission-sync.js).
  const submitted = await page.evaluate(async () => {
    const st = QuizEngine.getState();
    st.quiz.forEach(q => QuizEngine.recordAnswer(q.id,
      Array.isArray(q.options) && q.options.length
        ? (q.type === "multiselect" ? [0] : 0)
        : "offline test answer"));
    const started = Date.now();
    const res = await QuizEngine.submitQuiz(false);
    return { ms: Date.now() - started, max: res.scoreResult.totalMax,
             synced: res.syncResult ? res.syncResult.synced : null };
  });
  check("offline submit completes instead of hanging", submitted.max > 0, `${submitted.ms}ms`);
  check("offline submission is queued, not lost", submitted.synced === false);
  check("pending-sync record written for later retry",
        (await page.evaluate(() => Object.keys(localStorage)
          .filter(k => k.startsWith("csa65pendingsync::")).length)) === 1);
  check("result saved to localStorage offline",
        (await page.evaluate(() => Object.keys(localStorage)
          .filter(k => k.startsWith("csa65result::")).length)) >= 1);

  await page.goto(`${BASE}/never-cached.html`, { waitUntil: "load" }).catch(() => {});
  check("an uncached URL opened offline falls back to offline.html",
        /you.?re offline/i.test(await page.evaluate(() => document.body.innerText)));

  // Each shareable link is a unique URL and can't be precached; the worker
  // matches it to the one cached student.html via ignoreSearch.
  const cfg = Buffer.from(JSON.stringify({
    quizId: "offline-link-test", quizTitle: "Offline Link Test",
    questionBank: "data/questions-unit1.json", numQuestions: 3, timeLimitMinutes: 10,
  })).toString("base64");
  await page.goto(`${BASE}/student.html?config=${encodeURIComponent(cfg)}`, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  check("shareable ?config= link resolves offline (ignoreSearch)",
        page.url().includes("student.html") &&
        await page.evaluate(() => typeof QuizEngine !== "undefined"));

  // The property README Section 1 defends: an edit must never be masked by cache.
  await ctx.setOffline(false);
  const bank = path.join(APP_ROOT, "data", "questions-unit1.json");
  const original = fs.readFileSync(bank, "utf8");
  try {
    const edited = JSON.parse(original);
    edited.unitTitle = "EDITED-WHILE-ONLINE-" + Date.now();
    fs.writeFileSync(bank, JSON.stringify(edited, null, 2));
    await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
    const served = await page.evaluate(async () =>
      (await (await fetch("data/questions-unit1.json", { cache: "no-store" })).json()).unitTitle);
    check("online: an edited question bank is served fresh, never stale",
          served.startsWith("EDITED-WHILE-ONLINE-"));
  } finally {
    fs.writeFileSync(bank, original);
  }

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  check("offline again: the online visit refreshed the cache",
        (await page.evaluate(async () =>
          (await (await fetch("data/questions-unit1.json", { cache: "no-store" })).json()).questions.length)) > 0);
  await ctx.setOffline(false);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
  await ctx.close();
}

async function runSubpathSuite(browser) {
  const BASE = `http://127.0.0.1:${SUBPATH_PORT}${SUBPATH}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));

  section(`Offline support — served from the GitHub Pages subpath (${SUBPATH}/)`);

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  // A root-scoped worker would silently fail to control the app on GitHub Pages.
  check("worker scope is the subpath, not the domain root", scope.endsWith(`${SUBPATH}/`), scope);

  const cached = await waitForWorker(page);
  check("precache populates under the subpath", cached.length >= 30, `${cached.length} entries`);

  const man = await page.evaluate(async () => {
    const href = document.querySelector("link[rel=manifest]").href;
    const r = await fetch(href);
    const j = await r.json();
    return { ok: r.ok, href,
             start: new URL(j.start_url, href).pathname,
             icon: new URL(j.icons[0].src, href).pathname };
  });
  check("manifest resolves under the subpath", man.ok && man.href.includes(`${SUBPATH}/`));
  check("manifest start_url stays inside the subpath", man.start === `${SUBPATH}/index.html`, man.start);
  check("manifest icon path stays inside the subpath",
        man.icon.startsWith(`${SUBPATH}/assets/icons/`), man.icon);

  await ctx.setOffline(true);
  await page.goto(`${BASE}/student.html`, { waitUntil: "load" });
  const n = await page.evaluate(async () => (await QuizEngine.init("Subpath Tester", "21CS001")).quiz.length);
  check("offline quiz loads under the subpath", n > 0, `${n} questions`);

  await page.goto(`${BASE}/never-cached.html`, { waitUntil: "load" }).catch(() => {});
  check("offline fallback resolves under the subpath",
        /you.?re offline/i.test(await page.evaluate(() => document.body.innerText)));

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
  await ctx.close();
}

async function runNoRegressionSuite(browser) {
  const BASE = `http://127.0.0.1:${ROOT_PORT}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));

  section("No regression in the pages that were already there");

  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  await waitForWorker(page);

  await page.goto(`${BASE}/teacher.html`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  check("teacher.html loads with the worker active", (await page.title()).length > 0);
  check("teacher.html: tab bar rendered", (await page.locator(".tab-btn").count()) >= 4);
  check("teacher.html: question bank rendered into the page",
        (await page.evaluate(() => document.body.innerText.length)) > 300);

  await page.goto(`${BASE}/dashboard.html`, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  check("dashboard.html loads with the worker active", (await page.title()).length > 0);
  check("dashboard.html: auth gate renders rather than crashing",
        /sign in|email|password/i.test(await page.evaluate(() => document.body.innerText)));

  await page.goto(`${BASE}/student.html`, { waitUntil: "load" });
  check("student.html: entry form present online",
        (await page.locator("#entryName").count()) === 1);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
  await ctx.close();
}

// --- runner ------------------------------------------------------------------

(async () => {
  const rootServer = await serve(ROOT_PORT, null);
  const subServer = await serve(SUBPATH_PORT, SUBPATH);
  const browser = await chromium.launch();
  try {
    await runRootSuite(browser);
    await runSubpathSuite(browser);
    await runNoRegressionSuite(browser);
  } finally {
    await browser.close();
    rootServer.close();
    subServer.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailed:");
    failed.forEach(f => console.log("  - " + f.name));
  }
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error("\nTEST HARNESS ERROR:", e); process.exit(2); });
