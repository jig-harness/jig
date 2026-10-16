/**
 * Type guards, and decoding JSON through them.
 *
 * `JSON.parse` returns `any`, and a cast of it to a concrete type checks
 * nothing: malformed input then fails far from where it was read, with a
 * message that names neither the input nor the field. Here a parse returns
 * `unknown`, a guard narrows it, and a failure is a `DecodeError` that names
 * what was being read and where in it the shape broke.
 *
 * One definition of "a record" for every skill: a non-null object that is not
 * an array. (`config-layers.ts`'s `isMapping` is stricter, a plain object
 * only, for what a YAML document can hold.)
 */

/** A function that narrows `unknown` to `T`. */
export type Guard<T> = (value: unknown) => value is T;

/** A non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/**
 * A value that did not have the expected shape. `what` names the input (a
 * file, a command's output), `path` the place inside it (`$` for the whole
 * value, `$.state` for a field).
 */
export class DecodeError extends Error {
  readonly what: string;
  readonly path: string;
  readonly detail: string;
  constructor(what: string, path: string, detail: string, cause?: unknown) {
    super(
      `${what === "" ? "" : `${what}: `}${path} ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "DecodeError";
    this.what = what;
    this.path = path;
    this.detail = detail;
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
}

/**
 * `obj[key]`, narrowed by `guard`. Throws a `DecodeError` naming the field
 * when the value fails the guard (a missing key fails every guard that
 * rejects `undefined`). A guard built on `field()` therefore throws rather
 * than returning `false`; call it inside `decodeJson`, which completes the
 * error with the input's name. A failure inside a nested guard passes up
 * through each `field()` on the way, which adds its key to the path
 * (`$.pullRequest.state`) and keeps the inner error as the cause.
 */
export function field<T>(
  obj: Record<string, unknown>,
  key: string,
  guard: Guard<T>,
): T {
  const value = obj[key];
  try {
    if (guard(value)) return value;
  } catch (err) {
    if (err instanceof DecodeError && err.what === "")
      throw new DecodeError(
        "",
        `$.${key}${err.path.slice(1)}`,
        err.detail,
        err,
      );
    throw err;
  }
  throw new DecodeError(
    "",
    `$.${key}`,
    `is ${describe(value)}, which ${guard.name || "the guard"} rejects`,
  );
}

/**
 * Parse `text` as JSON and narrow it with `guard`, or throw a `DecodeError`
 * naming `what`: for text that is not JSON (path `$`, the parser's message
 * kept as the cause), for a value the guard rejects, and for a `field` the
 * guard read that failed.
 *
 * `guard` may be a plain type guard, or a function that reads fields with
 * `field()` and returns `true`; either way the result is typed `T`.
 */
export function decodeJson<T>(text: string, guard: Guard<T>, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new DecodeError(
      what,
      "$",
      `is not JSON (${err instanceof Error ? err.message : String(err)})`,
      err,
    );
  }
  try {
    if (guard(value)) return value;
  } catch (err) {
    if (err instanceof DecodeError && err.what === "")
      throw new DecodeError(what, err.path, err.detail, err);
    throw err;
  }
  throw new DecodeError(
    what,
    "$",
    `is ${describe(value)}, which ${guard.name || "the guard"} rejects`,
  );
}
