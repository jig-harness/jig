/** Reuse answers under their source's update time or validator. Storage remains the caller's. */
export interface VersionedStore {
  get<T>(key: string): T | null | undefined;
  set<T>(key: string, value: T): void;
}

/** A missing version never authorizes reuse. Thrown reads never become cache entries. */
export async function cacheByVersion<T>(
  store: VersionedStore,
  key: string,
  version: string | null | undefined,
  read: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const held = version
    ? store.get<{ version: string; value: T }>(key)
    : undefined;
  if (held && held.version === version && version) return held.value;
  const value = await read();
  if (version && keep(value)) store.set(key, { version, value });
  return value;
}

export interface ValidatedBody {
  etag: string;
  body: string;
}

/** Validator entries moved from the forge's conditional-request cache, including its request guard. */
export function validatorCache(store: {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}) {
  return {
    get(key: string, request: string): ValidatedBody | null {
      const value = store.get(key);
      if (typeof value !== "object" || value === null) return null;
      const entry = value as Record<string, unknown>;
      return entry.v === 1 &&
        entry.path === request &&
        typeof entry.etag === "string" &&
        entry.etag !== "" &&
        typeof entry.body === "string"
        ? { etag: entry.etag, body: entry.body }
        : null;
    },
    set(key: string, request: string, etag: string, body: string): void {
      if (etag !== "") store.set(key, { v: 1, path: request, etag, body });
    },
  };
}
