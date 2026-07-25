/**
 * theme.js
 * ---------------------------------------------------------------------------
 * Light/dark mode toggle. The actual `data-theme` attribute is set as early
 * as possible by a small inline script in each page's <head> (before the
 * stylesheet paints) to avoid a flash of the wrong theme — this module only
 * handles the toggle button's click behavior and persisting the choice.
 * ---------------------------------------------------------------------------
 */

const Theme = (() => {
  const KEY = "csa65theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") || "light";
  }

  function updateButtonLabel() {
    const btn = document.getElementById("themeToggleBtn");
    if (btn) btn.textContent = current() === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(KEY, theme); } catch (e) { /* localStorage unavailable */ }
    updateButtonLabel();
  }

  function toggle() {
    apply(current() === "dark" ? "light" : "dark");
  }

  function init() {
    updateButtonLabel();
    const btn = document.getElementById("themeToggleBtn");
    if (btn) btn.addEventListener("click", toggle);
  }

  return { init, toggle };
})();
