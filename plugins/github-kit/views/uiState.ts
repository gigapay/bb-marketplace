// UI state that should survive leaving the GitHub page: BB unmounts the page
// when you navigate away and reopens it on the bare list route. Kept in
// sessionStorage, so it lasts for the app session and nothing more.

const PREFIX = "github-kit.ui.";

export function readUi<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeUi(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage off or full: we just won't restore.
  }
}

export const isString = (value: unknown): value is string => typeof value === "string";
