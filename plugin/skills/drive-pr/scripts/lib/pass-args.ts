/**
 * Extra arguments for a drive's pass command, and the permission mode the
 * pass runs in.
 *
 * A pass is one round's agent process. When it is Claude Code's CLI
 * (`claude`), its command can carry extra words before `-p`, such as
 * `--permission-mode bypassPermissions`: without that mode a pass started
 * without a terminal is denied every write under a protected path such as
 * `.claude/skills/**`. The words come, in this order, from:
 *
 *   1. `--pass-args "<words>"` on `arm-drive.ts` or `drive.ts`, for one
 *      drive: the value split on whitespace (no quoting, since a word holds
 *      no space); an empty value adds none and keeps `drive.pass_args` out;
 *   2. `drive.pass_args`, a list of words, added only to a pass command that
 *      carries no arguments of its own (`claude`, its `--model`, `-p` and the
 *      prompt): a command that carries its own is kept as written, so a
 *      re-arm or takeover command printed from a running drive runs the same
 *      arguments it shows, whatever the configuration says by then.
 *
 * Words the pass command already carries as one run are not added twice:
 * the command `arm-drive.ts` builds already holds them. A pass command that
 * is not `claude` ignores `drive.pass_args` and says so, and refuses
 * `--pass-args`, whose words are Claude Code's grammar. The permission mode
 * is read from the command as it runs (`--permission-mode X`, or
 * `--dangerously-skip-permissions` for `bypassPermissions`), and is
 * `inherited` (Claude Code's own settings decide) when the command sets none.
 */
import { basename } from "node:path";
import { passVendor } from "./identity.ts";
import {
  DEFAULT_PASS_ARGS,
  passArgsSetting,
  refusedPassArgs,
} from "./overlay.ts";
import { withoutModel } from "./pass-model.ts";

/** Extra pass arguments and where they came from. */
export interface PassArgs {
  words: string[];
  source: string;
}

/** A `--pass-args` value the driver cannot use: a usage error (exit 2). */
export class PassArgsUsageError extends Error {}

/** `--pass-args`'s value as words: split on whitespace; blank for none. */
export function parsePassArgsFlag(value: string): string[] {
  const words = value.split(/\s+/).filter((word) => word !== "");
  const refused = refusedPassArgs(words);
  if (refused !== undefined)
    throw new PassArgsUsageError(`--pass-args ${refused}`);
  return words;
}

/** The words the configuration asks for: `drive.pass_args`, else none. */
export function configuredPassArgs(): PassArgs {
  const words = passArgsSetting();
  return words === undefined
    ? {
        words: [...DEFAULT_PASS_ARGS],
        source: "the default; drive.pass_args is not set",
      }
    : { words, source: "drive.pass_args" };
}

/** The words an arm writes into its command: `--pass-args`, else `drive.pass_args`. */
export function chosenPassArgs(
  flag: string | undefined,
  configured: () => PassArgs = configuredPassArgs,
): PassArgs {
  return flag === undefined
    ? configured()
    : { words: parsePassArgsFlag(flag), source: "--pass-args" };
}

/** The words that start a Claude Code pass's prompt. */
const PRINT = new Set(["-p", "--print"]);

/** Whether `argv` holds `words`, in order, as one run. */
function carries(argv: readonly string[], words: readonly string[]): boolean {
  if (words.length === 0) return true;
  for (let i = 1; i + words.length <= argv.length; i++)
    if (words.every((word, j) => argv[i + j] === word)) return true;
  return false;
}

/**
 * `argv` with `words` before its `-p` (at the end when it has none), unless
 * it already carries them as one run.
 */
export function withPassArgs(
  argv: readonly string[],
  words: readonly string[],
): string[] {
  if (carries(argv, words)) return [...argv];
  const print = argv.findIndex((word, i) => i > 0 && PRINT.has(word));
  const at = print === -1 ? argv.length : print;
  return [...argv.slice(0, at), ...words, ...argv.slice(at)];
}

/** Whether a `claude` pass command carries words beyond its model, `-p` and the prompt. */
function hasOwnArgs(argv: readonly string[]): boolean {
  const rest = withoutModel(argv).slice(1);
  return !(rest.length === 2 && rest.some((word) => PRINT.has(word)));
}

/**
 * Whether a printed re-arm or takeover command must carry `--pass-args ''`:
 * a Claude Code pass command with no arguments of its own, run where
 * `drive.pass_args` names some, got there only by an empty override, and a
 * command that did not say so would pick the configured words up again.
 */
export function pinsEmptyPassArgs(
  argv: readonly string[],
  configured: () => PassArgs = configuredPassArgs,
): boolean {
  return (
    argv[0] !== undefined &&
    passVendor(argv) === "claude" &&
    !hasOwnArgs(argv) &&
    configured().words.length > 0
  );
}

/** The permission mode a pass runs in and where it was read. */
export interface PermissionMode {
  /** `null` when the pass command is not Claude Code's. */
  mode: string | null;
  source: string;
}

/**
 * The permission mode a `claude` pass command sets; `inherited` when it sets
 * none, since Claude Code then reads `permissions.defaultMode` from its
 * settings and the command cannot say which mode that is.
 */
export function permissionMode(argv: readonly string[]): PermissionMode {
  if (argv.slice(1).includes("--dangerously-skip-permissions"))
    return {
      mode: "bypassPermissions",
      source: "the pass command's --dangerously-skip-permissions",
    };
  let mode: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === "--permission-mode" && i + 1 < argv.length)
      mode = argv[i + 1] as string;
    else if (word.startsWith("--permission-mode="))
      mode = word.slice("--permission-mode=".length);
  }
  return mode === null
    ? {
        mode: "inherited",
        source:
          "the pass command sets no --permission-mode; Claude Code's settings decide",
      }
    : { mode, source: "the pass command's --permission-mode" };
}

/** The pass command with its extra arguments decided, and the driver log's lines. */
export interface EffectivePassArgs {
  argv: string[];
  /** The driver log's `pass args:` line. */
  line: string;
  permission: PermissionMode;
}

/** The driver log's line naming the permission mode. */
export function permissionLine(permission: PermissionMode): string {
  return permission.mode === null
    ? `permission mode: ${permission.source}`
    : `permission mode: ${permission.mode} (${permission.source})`;
}

/** The words as a log shows them. */
function shown(words: readonly string[]): string {
  return words.length === 0 ? "none" : words.join(" ");
}

/** A non-Claude pass command: `drive.pass_args` ignored and said so, `--pass-args` refused. */
function otherPass(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassArgs,
): EffectivePassArgs {
  const name = basename(argv[0] as string);
  if (flag !== undefined && parsePassArgsFlag(flag).length > 0)
    throw new PassArgsUsageError(
      `--pass-args applies to a Claude Code pass command (claude …); give '${name}' its arguments after --`,
    );
  const set = configured().words.length > 0;
  return {
    argv: [...argv],
    line: set
      ? `pass args: none; drive.pass_args applies to a Claude Code pass command, and '${name}' ignores it`
      : `pass args: none (the pass command is ${name})`,
    permission: { mode: null, source: `chosen by the pass command (${name})` },
  };
}

/**
 * The pass command with its extra arguments decided (see the module
 * header), from the command as given (its model already decided), the
 * `--pass-args` flag and the configured words.
 */
export function effectivePassArgs(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassArgs = configuredPassArgs,
): EffectivePassArgs {
  if (argv[0] === undefined)
    return {
      argv: [],
      line: "pass args: no pass command given",
      permission: { mode: null, source: "no pass command given" },
    };
  if (passVendor(argv) !== "claude") return otherPass(argv, flag, configured);
  const done = (out: string[], line: string): EffectivePassArgs => ({
    argv: out,
    line,
    permission: permissionMode(out),
  });
  const chosen = chosenPassArgs(flag, configured);
  const already = chosen.words.length > 0 && carries(argv, chosen.words);
  const written = `${shown(chosen.words)} (${chosen.source}, as written in the pass command)`;
  if (flag !== undefined)
    return done(
      withPassArgs(argv, chosen.words),
      `pass args: ${already ? written : `${shown(chosen.words)} (${chosen.source})`}`,
    );
  if (already) return done([...argv], `pass args: ${written}`);
  if (hasOwnArgs(argv))
    return done(
      [...argv],
      chosen.words.length === 0
        ? "pass args: the pass command's own, kept as written"
        : `pass args: the pass command's own, kept as written; ${chosen.source} (${shown(chosen.words)}) is added only to a pass command without arguments of its own`,
    );
  return done(
    withPassArgs(argv, chosen.words),
    `pass args: ${shown(chosen.words)} (${chosen.source})`,
  );
}
