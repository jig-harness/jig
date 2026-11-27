/**
 * The variables an installed job runs with beyond the ones Jig writes into
 * it. A scheduled job reads no shell profile, so a credential its runs need
 * (a tracker's, a notification channel's address) has to be in the job
 * itself. Two ways put one there:
 *
 * - **Kept from the installed job.** A variable a person added to an
 *   installed launchd job's `EnvironmentVariables` is carried into the job
 *   an install writes in its place, so a reinstall does not drop it. Jig's
 *   own variables (`managed`) are written fresh, never carried.
 * - **Captured by name.** `--env NAME` reads the variable's value from the
 *   installing shell. It takes a name only, never `NAME=VALUE`, so a value
 *   never reaches shell history or the process list.
 *
 * Either way a value is never shown: a preview names the variables only.
 */
import { failed, ok, type Outcome } from "../shared/outcome.ts";

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};

/**
 * A plist string's text, its XML escapes undone in one pass, numeric
 * references included; a reference that names no character stays as written.
 */
export function unxml(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|quot|apos|amp));/g,
    (whole, hex?: string, decimal?: string, named?: string) => {
      if (named !== undefined) return NAMED_ENTITIES[named] ?? whole;
      const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/**
 * A launchd job's `EnvironmentVariables`, read whole or not at all: the form
 * `jobFiles` writes, or the same keys laid out on lines of their own, as a
 * person's edit with a plist tool leaves them. XML comments are ignored; an
 * entry that is not a plain `<string>` (CDATA, a number, a nested dictionary)
 * makes the block `unreadable`, never a smaller one. A job with no
 * environment holds none.
 */
export function parseLaunchdEnvironment(
  plist: string,
): Outcome<Record<string, string>, "unreadable"> {
  const text = plist.replace(/<!--.*?-->/gs, "");
  // A comment opener left after removal is an unclosed comment or one that
  // removal reassembled (`<!<!---->--`): neither is read as a smaller block.
  if (text.includes("<!--"))
    return failed(
      "unreadable",
      "it holds an XML comment that is not closed or is nested; remove it, then install again",
    );
  const start = /<key>EnvironmentVariables<\/key>\s*<dict\s*(\/?)>/.exec(text);
  if (start === null) {
    return text.includes("<key>EnvironmentVariables</key>")
      ? failed(
          "unreadable",
          "its EnvironmentVariables is not a dictionary; make it a <dict> of <string> values, then install again",
        )
      : ok({});
  }
  if (start[1] === "/") return ok({});
  const rest = text.slice(start.index + start[0].length);
  const end = rest.indexOf("</dict>");
  if (end < 0)
    return failed(
      "unreadable",
      "its EnvironmentVariables dictionary is not closed",
    );
  const entries: [string, string][] = [];
  const entry =
    /\s*<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\s*\/>)/y;
  const body = rest.slice(0, end);
  let at = 0;
  while (body.slice(at).trim() !== "") {
    entry.lastIndex = at;
    const match = entry.exec(body);
    if (match === null)
      return failed(
        "unreadable",
        "an EnvironmentVariables entry is not a string (a plain <string> without CDATA); make each value one, then install again",
      );
    entries.push([unxml(match[1] as string), unxml(match[2] ?? "")]);
    at = entry.lastIndex;
  }
  const seen = new Set<string>();
  for (const [name] of entries) {
    if (seen.has(name))
      return failed(
        "unreadable",
        `EnvironmentVariables names ${name} more than once, so which value it holds is unclear; keep one entry, then install again`,
      );
    seen.add(name);
  }
  // Own data properties, so a variable named `__proto__` stays a variable.
  return ok(Object.fromEntries(entries));
}

/** What a preview shows in place of a value it must not print. */
export const HIDDEN_VALUE = "(hidden)";

/** A variable's name as a shell exports it. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables the installed launchd job (`plist`, null when there is
 * none) holds that are not `managed`: what a reinstall keeps. A job whose
 * variables cannot all be read and written back is `unreadable`, never read
 * as one with none: a binary plist, an entry whose value is not a string,
 * or a kept value with a line break. No reason repeats a value.
 */
export function carriedEnvironment(
  plist: string | null,
  managed: ReadonlySet<string>,
): Outcome<Record<string, string>, "unreadable"> {
  if (plist === null) return ok({});
  if (!/^\s*(<\?xml|<!DOCTYPE|<plist)/.test(plist))
    return failed(
      "unreadable",
      "it is not an XML plist; convert it with plutil -convert xml1, then install again",
    );
  const read = parseLaunchdEnvironment(plist);
  if (!read.ok) return failed("unreadable", read.failure.reason);
  const env = read.value;
  const carried = Object.entries(env).filter(([name]) => !managed.has(name));
  const broken = carried.find(([, value]) => /[\r\n\0]/.test(value));
  if (broken)
    return failed(
      "unreadable",
      `the value of ${broken[0]} holds a line break or NUL, which the installed job cannot keep; rewrite or remove it, then install again`,
    );
  return ok(Object.fromEntries(carried));
}

/**
 * The values of the variables `names` in `env`, the installing shell's, or
 * why they cannot be captured: a `NAME=VALUE` form, a word that is not a
 * name, a variable Jig writes itself (`managed`), or one unset, empty or
 * holding a line break. No refusal repeats a value.
 */
export function capturedEnvironment(
  names: readonly string[],
  env: Record<string, string | undefined>,
  managed: ReadonlySet<string>,
): Outcome<Record<string, string>, "usage"> {
  const captured: Record<string, string> = {};
  for (const name of names) {
    const refusal = captureRefusal(name, env[name], managed);
    if (refusal !== null) return failed("usage", refusal);
    captured[name] = env[name] as string;
  }
  return ok(captured);
}

function captureRefusal(
  name: string,
  value: string | undefined,
  managed: ReadonlySet<string>,
): string | null {
  const equals = name.indexOf("=");
  if (equals >= 0) {
    const before = name.slice(0, equals);
    const named = NAME.test(before) ? before : "NAME";
    return `--env takes a variable's name, never NAME=VALUE: a value on the command line lands in shell history and the process list. Export ${named} in this shell, then pass --env ${named}`;
  }
  if (!NAME.test(name))
    return "--env takes a variable's name: letters, digits and underscores, not starting with a digit";
  if (managed.has(name))
    return `--env ${name}: Jig writes ${name} into the job itself`;
  if (value === undefined || value === "")
    return `--env ${name}: ${name} is unset or empty in this shell; export it first`;
  if (/[\r\n\0]/.test(value))
    return `--env ${name}: its value holds a line break or NUL, which a scheduled job cannot carry`;
  return null;
}

/** `env` with the value of each name in `hidden` replaced by `HIDDEN_VALUE`. */
export function maskedEnvironment(
  env: Record<string, string>,
  hidden: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      hidden.has(name) ? HIDDEN_VALUE : value,
    ]),
  );
}
