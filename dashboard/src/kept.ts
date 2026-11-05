/**
 * What the page keeps in this browser alone: the theme a person chose and the
 * replies they are drafting. Nothing here reaches the host. A browser that
 * refuses storage (a private window, a policy) keeps nothing, and the page
 * works as before.
 */

const PREFIX = "jig-dispatch-dashboard:";

// A browser refuses storage, or has no room left, by a DOMException; any other
// failure is not an answer about storage.

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch (cause) {
    if (!(cause instanceof DOMException)) throw cause;
    return null;
  }
}

/** The value kept under `key`, or `null` when none is or storage is refused. */
export function readKept(key: string): string | null {
  try {
    return store()?.getItem(PREFIX + key) ?? null;
  } catch (cause) {
    if (!(cause instanceof DOMException)) throw cause;
    return null;
  }
}

/** Keeps `value` under `key`, or forgets it when `value` is `null`; whether it was kept. */
export function writeKept(key: string, value: string | null): boolean {
  const kept = store();
  if (kept === null) return false;
  try {
    if (value === null) kept.removeItem(PREFIX + key);
    else kept.setItem(PREFIX + key, value);
    return true;
  } catch (cause) {
    // A full or refused store keeps nothing; the value lives on in the page.
    if (!(cause instanceof DOMException)) throw cause;
    return false;
  }
}

/** Every key kept under `prefix`, without the page's own prefix. */
export function keptKeys(prefix: string): string[] {
  const kept = store();
  if (kept === null) return [];
  const keys: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const key = kept.key(i);
    if (key?.startsWith(PREFIX + prefix)) keys.push(key.slice(PREFIX.length));
  }
  return keys;
}
