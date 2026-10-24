const KEY = "nexus_theme";

export function getTheme() {
  try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* storage unavailable */ }
}
