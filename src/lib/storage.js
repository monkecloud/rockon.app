// Client-side session persistence — plain localStorage, so the logged-in
// session survives page refreshes. The user *database* itself lives on the
// server (see server/worker.js + server/users.json), which is what makes
// it shared across everyone hitting this server rather than per-browser.
// Guarded so this file also behaves in environments without a browser
// window (e.g. server-side rendering).
export const STORAGE_KEYS = {
  currentUser: "boilerplate:currentUser",
};

export function loadFromStorage(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error("Failed to read from localStorage:", err);
    return fallback;
  }
}

export function saveToStorage(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error("Failed to write to localStorage:", err);
  }
}
