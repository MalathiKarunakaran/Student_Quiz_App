/**
 * code-runner.js
 * ---------------------------------------------------------------------------
 * Runs student-edited Python in the browser via Pyodide (WebAssembly CPython),
 * loaded lazily from a CDN on first use. No server, no API key: the
 * interpreter and the code both execute entirely on the student's machine.
 * This is a sandbox for self-checking "codeoutput"/"debugging" questions —
 * it does not feed into scoring (see question-renderer.js), so a slow or
 * blocked CDN degrades to "Run Code" being unavailable, not a broken quiz.
 * ---------------------------------------------------------------------------
 */

const CodeRunner = (() => {
  let pyodidePromise = null;

  function loadPyodide_() {
    if (pyodidePromise) return pyodidePromise;
    pyodidePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
      script.onload = () => {
        window.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/" })
          .then(resolve)
          .catch(reject);
      };
      script.onerror = () => reject(new Error("Could not load the Python runtime (offline, or the CDN is blocked)."));
      document.head.appendChild(script);
    });
    return pyodidePromise;
  }

  /**
   * Runs `code` and returns { ok, output } where output is combined
   * stdout/stderr text (stderr only present on failure).
   */
  async function run(code) {
    const pyodide = await loadPyodide_();
    pyodide.setStdout({ batched: (s) => { run._out += s + "\n"; } });
    pyodide.setStderr({ batched: (s) => { run._out += s + "\n"; } });
    run._out = "";
    try {
      await pyodide.runPythonAsync(code);
      return { ok: true, output: run._out || "(no output)" };
    } catch (e) {
      return { ok: false, output: (run._out ? run._out + "\n" : "") + String(e.message || e) };
    }
  }

  return { run };
})();
