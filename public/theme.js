/* Sets <html data-theme> before the first paint, the same way ThemeContext does: the stored
   choice ("hk-theme"), else the system setting. The dark tokens then live in one place in
   styles.css instead of a second copy under @media (prefers-color-scheme: dark). */
(function () {
  var t = null;
  try { t = localStorage.getItem("hk-theme"); } catch (e) { /* storage blocked: follow the system */ }
  if (t !== "light" && t !== "dark") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
})();
