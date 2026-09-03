/**
 * A tiny read-through cache in localStorage for the data the shell needs before it can draw
 * anything useful.
 *
 * The dashboard used to hold a full-screen spinner until /api/auth/status answered, then show an
 * empty tree until /api/projects did. On the deployed hub that is a visibly blank second or two
 * on every single navigation, for a list that is nearly always identical to last time. Seeding
 * from the last known value lets the tree paint immediately and be corrected a moment later.
 *
 * Deliberately not used for anything a stale value would mislead about — costs, sync state,
 * secrets. Only for the shape of the interface.
 */
export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`sync-hub-cache:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Private windows, cleared site data, quota — none of which should stop the app rendering.
    return null;
  }
}

export function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(`sync-hub-cache:${key}`, JSON.stringify(value));
  } catch {
    // A full quota is not worth an error path: the next load simply starts cold.
  }
}
