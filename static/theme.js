/* Dark / Light / System theme. Loaded synchronously in <head> so there is no flash of the wrong theme. */
(function () {
  var KEY = "eka:theme", root = document.documentElement, mq = window.matchMedia ? matchMedia("(prefers-color-scheme: light)") : null;
  function get() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" || v === "system" ? v : "dark"; } catch (e) { return "dark"; } }
  function effective(m) { return m === "system" ? (mq && mq.matches ? "light" : "dark") : m; }
  function apply(m) {
    var e = effective(m); root.setAttribute("data-theme", e); root.setAttribute("data-theme-mode", m);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta && document.head) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.appendChild(meta); }
    if (meta) meta.content = e === "light" ? "#ffffff" : "#080808";
    var L = { dark: "☾ Dark", light: "☀ Light", system: "◐ Auto" };
    [].forEach.call(document.querySelectorAll(".theme-toggle"), function (b) { b.textContent = L[m]; b.setAttribute("aria-label", "Theme: " + m + ". Tap to change."); b.title = "Theme: " + m; });
  }
  function set(m) { try { localStorage.setItem(KEY, m); } catch (e) {} apply(m); }
  function cycle() { var m = get(); set(m === "dark" ? "light" : m === "light" ? "system" : "dark"); }
  apply(get());
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (get() === "system") apply("system"); });
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(get()); });
  window.ekaTheme = { get: get, set: set, effective: function () { return effective(get()); } };

  function mount() {
    function make(cls) { var b = document.createElement("button"); b.type = "button"; b.className = "theme-toggle " + (cls || ""); b.addEventListener("click", cycle); return b; }
    var made = 0, side = document.querySelector(".sidebar .sidebar-signout, .sidebar .side-note");
    if (side) { var b1 = make("in-side"); side.parentNode.insertBefore(b1, side); made++; }
    var bar = document.querySelector(".topbar .actions, .entry-mobilebar, .xw-top");
    if (bar) { bar.classList.contains("xw-top") ? bar.appendChild(make("in-bar")) : bar.insertBefore(make("in-bar"), bar.firstChild); made++; }
    if (!made || !document.querySelector(".sidebar")) { if (!bar) document.body.appendChild(make("floating")); }
    apply(get());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
