/**
 * Shared CLI helpers for the do-item scripts — the counterpart to
 * resolve-review-comments' `scripts/lib/cli.ts`.
 *
 * Each entry script carried a byte-identical `isEntryPoint` plus its
 * explanatory comment, and each hand-rolled the same argv walk its own way.
 * One copy of each lives here.
 *
 * `node:` APIs only, erasable-syntax-only TypeScript: these run under Bun and
 * under Node ≥ 22.18 (type stripping), same as their callers.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is the module at `moduleUrl` the process's entry script?
 *
 * NOT `import.meta.main` (a Bun global Node gained only in v24.2 — below that
 * it reads `undefined` and the script silently prints nothing). Both runtimes
 * realpath the entry module's URL while argv[1] stays as typed, so both sides
 * are realpath'd before comparing — this survives invocation through the
 * `.agents/skills/` symlink farm and macOS's /var → /private/var link.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(resolve(argv1)) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

export interface ParsedArgs {
  /** Boolean flags seen, by name (`--verbose` → `verbose`). */
  flags: Set<string>;
  /** Value flags seen, by name (`--catalog x` → `catalog` → `x`). */
  values: Map<string, string>;
  /** The single positional argument. */
  positional: string;
}

/**
 * Parse `argv` against a declared option set, or return a usage message.
 *
 * The Python originals used `argparse`, which rejects an unknown flag and an
 * extra positional with exit 2. The hand-written ports did neither: two of
 * them took the FIRST non-flag argument and silently dropped unknown flags and
 * later positionals, while determine_agent.ts treated every unrecognised
 * token — flag or not — as the input path, last one winning. So
 * `get_issue.ts ENG-123 --typo`, `get_issue.ts ENG-123 ENG-124` and
 * `determine_agent.ts - --typo` each proceeded or failed as a generic runtime
 * error rather than as the usage error argparse gave them. At most one
 * positional is accepted because no script here takes two; whether omitting it
 * is legal comes from `spec.defaultPositional`, mirroring each script's own
 * argparse declaration.
 */
export function parseArgs(
  argv: string[],
  spec: {
    flags: readonly string[];
    values: readonly string[];
    usage: string;
    /**
     * Value for an OMITTED positional. Present only where the Python
     * predecessor declared one — `determine_agent.py` used
     * `nargs="?", default="-"`, so a bare invocation read stdin. Omit it and
     * the positional is required, as `get_issue.py` declared its own
     * (requiring one everywhere silently narrowed determine_agent's public
     * CLI contract).
     *
     * Mutually exclusive with `noPositional` — this is for a script that
     * takes an OPTIONAL positional (`nargs='?'`), not one that takes NONE.
     */
    defaultPositional?: string;
    /**
     * This script takes NO positional at all, as opposed to an optional one
     * with a default. A caller previously faked this with
     * `defaultPositional: ''`, but that is `nargs='?'` semantics: it accepts
     * a single supplied positional (silently ignored, since nothing reads
     * `.positional`) and only the `positionals.length > 1` check below ever
     * rejects anything — so exactly one stray positional slipped through
     * unrejected. This
     * flag rejects any positional, including exactly one.
     */
    noPositional?: boolean;
  },
): { ok: true; args: ParsedArgs } | { ok: false; message: string } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  const bad = (message: string) => ({
    ok: false as const,
    message: `${message}\n${spec.usage}`,
  });

  // argparse's own rule: a token starting with `-` is an option, EXCEPT a bare
  // `-`, which is a positional — determine_agent.ts's stdin sentinel. Testing
  // for `--` alone left single-dash tokens as ordinary values, so
  // `- --catalog -v` took `-v` as the catalog path, silently failed to load it
  // and let a catalog-only label fall through to the default agent, where
  // argparse rejects the unknown option (an earlier fix closed the same hole
  // one token class narrower).
  const isOption = (t: string) => t.startsWith("-") && t !== "-";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    // argparse's option TERMINATOR: everything after a bare `--` is a
    // positional, however it is spelled. This is how a caller passes a path
    // that itself starts with a dash.
    //
    // MEASURED CAVEAT: only the Node entry point can use it. `bun script.ts --
    // -x` strips the `--` before argv reaches the script, while `node
    // script.ts -- -x` passes it through, so a dash-leading path is
    // addressable under Node and not under Bun. Handled here rather than
    // worked around because the parser's job is the argv it is given; the
    // runtime difference belongs in the caller's docs, and the unit tests
    // exercise this function directly for exactly that reason.
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (isOption(a)) {
      // Only long options are declared, so a single-dash token can never
      // match one and falls through to the unknown-option refusal below.
      // `--opt=value` is argparse's other accepted spelling for a value
      // option, and recognising only the whole-token form refused it as an
      // unknown option (same round). A flag never takes one, so
      // `--verbose=x` still refuses.
      const eq = a.indexOf("=");
      const name = a.startsWith("--")
        ? a.slice(2, eq < 0 ? undefined : eq)
        : "";
      const inlineValue = eq < 0 ? undefined : a.slice(eq + 1);
      if (spec.flags.includes(name)) {
        if (inlineValue !== undefined) {
          return bad(`--${name} does not take a value`);
        }
        flags.add(name);
      } else if (spec.values.includes(name)) {
        if (inlineValue !== undefined) {
          // `--catalog=` is an explicit empty value, which no path can be.
          if (inlineValue === "") return bad(`${a} requires a value`);
          values.set(name, inlineValue);
          continue;
        }
        // A following OPTION token is a missing value, not the value. argparse
        // refused `--catalog --verbose` with exit 2; consuming `--verbose` as
        // the catalog path had the same effect described above.
        const value = i + 1 < argv.length ? argv[i + 1] : undefined;
        if (value === undefined || isOption(value) || value === "--") {
          return bad(`${a} requires a value`);
        }
        values.set(name, value);
        i++;
      } else {
        return bad(`unknown option: ${a}`);
      }
    } else {
      positionals.push(a);
    }
  }

  if (spec.noPositional) {
    if (positionals.length > 0) {
      return bad(`expected no positional argument, got ${positionals.length}`);
    }
    return { ok: true, args: { flags, values, positional: "" } };
  }
  if (positionals.length === 0) {
    if (spec.defaultPositional === undefined) {
      return bad("missing required argument");
    }
    positionals.push(spec.defaultPositional);
  }
  if (positionals.length > 1) {
    return bad(`expected exactly one argument, got ${positionals.length}`);
  }
  // Exactly one positional remains: none was filled from the default above,
  // and more than one was refused.
  const positional = positionals[0] as string;
  return { ok: true, args: { flags, values, positional } };
}
