/**
 * Reuse answers under their source's update time or validator, and the
 * conditional request: a read sent with the validator of the answer it
 * holds (`If-None-Match`), which the system answers `304 Not Modified`,
 * charging nothing, when nothing changed. Storage remains the caller's.
 */
import { failed, ok, type Outcome } from "../outcome.ts";

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

/** The header that makes a read conditional on the answer held: `If-None-Match` with its validator; none when nothing is held. */
export function conditionalHeaders(
  held: ValidatedBody | null,
): Record<string, string> {
  return held === null ? {} : { "If-None-Match": held.etag };
}

/** What a conditional read's answer comes to: the body, whether it changed, and the validated body to keep (`null`: keep nothing new). */
export interface Revalidated {
  changed: boolean;
  body: string;
  keep: ValidatedBody | null;
}

/**
 * What an answer of `status` to a read sent with `held`'s validator comes
 * to: a `304` is the held body, unchanged; a success is its own body, kept
 * with its validator when it carries one. A `304` to a read that held
 * nothing cannot be trusted (`unvalidated`); any other status is `null`,
 * for the transport to classify.
 */
export function revalidated(
  status: number,
  etag: string,
  body: string,
  held: ValidatedBody | null,
): Outcome<Revalidated, "unvalidated"> | null {
  if (status === 304)
    return held === null
      ? failed("unvalidated", "a 304 answer to a read that held nothing")
      : ok({ changed: false, body: held.body, keep: null });
  if (status < 200 || status >= 300) return null;
  return ok({
    changed: true,
    body,
    keep: etag === "" ? null : { etag, body },
  });
}
