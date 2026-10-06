// UX-012: the saved theme before the first paint (see src/lib/theme.ts). Served as a same-origin
// file (not inline) so the SPA's CSP can keep script-src 'self' with no 'unsafe-inline' (S-6).
try {
  var c = localStorage.getItem("budget-os.theme");
  var dark = c === "dark" || (c !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch (e) {
  document.documentElement.dataset.theme = "light";
}
