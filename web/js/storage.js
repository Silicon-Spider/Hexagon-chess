// storage.js — localStorage helpers. Every access is wrapped in try/catch: the page
// must keep working when storage is unavailable (private mode, file://, quota, policy).

const PREFIX = 'hexchess.';

function store() {
  try {
    return globalThis.localStorage || null;
  } catch (e) {
    return null;
  }
}

export function loadJSON(key, fallback = null) {
  try {
    const s = store();
    if (!s) return fallback;
    const raw = s.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function removeKey(key) {
  try {
    const s = store();
    if (s) s.removeItem(PREFIX + key);
  } catch (e) {
    /* ignore */
  }
}
