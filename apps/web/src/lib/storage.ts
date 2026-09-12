/**
 * Storage helpers that survive blocked/disabled `localStorage` (private mode,
 * strict cookie settings): reads return null and writes are no-ops instead of
 * throwing and killing the SPA boot.
 */

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode / disabled) — session stays in memory */
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
