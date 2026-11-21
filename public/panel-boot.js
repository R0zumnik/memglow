/*! memglow — control panel: applies the saved theme before the first paint (no flash). MIT. */
(function () {
  try {
    var t = localStorage.getItem("memglow.panel.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* blocked storage: the system theme applies */ }
})();
