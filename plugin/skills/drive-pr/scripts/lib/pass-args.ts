/**
 * Extra arguments for a drive's pass command, and the permission mode the
 * pass runs in.
 *
 * A pass is one round's agent process. When it is Claude Code's CLI
 * (`claude`), its command can carry extra words before `-p`, such as
 * `--permission-mode bypassPermissions`: without that mode a pass started
 * without a terminal is denied every write under a protected path such as
 * `.claude/skills/**`. When it is Codex's (`codex exec`), its command can
 * carry extra words before the prompt, after the bypass `drive.codex_bypass`
 * adds, such as `--dangerously-bypass-hook-trust`: Codex runs only the hooks
 * it has been told to trust, and a pass started without a terminal cannot
 * ask. Every source of those words is on the host's side, since a pull
 * request can edit the repository's own file and a drive reads it from that
 * pull request's checkout (`shared/config-layers.ts` refuses both fields
 * there). The words come, in this order, from:
 *
 *   1. `--pass-args "<words>"` on `arm-drive.ts` or `drive.ts`, for one
 *      drive: the value split on whitespace (no quoting, since a word holds
 *      no space). Its words are Claude Code's grammar, so a Codex pass
 *      refuses them; an empty value adds none, to either, and keeps the
 *      setting out;
 *   2. the setting of the pass command's tool, a list of words in the
 *      host's user file or one run's environment: `drive.pass_args` for
 *      Claude Code, `drive.codex_pass_args` for Codex (`codex-pass-args.ts`
 *      says which words it refuses). It is added only to a pass command that
 *      carries no arguments of its own (`claude`, its `--model`, `-p` and the
 *      prompt; `codex exec`, its `-m`, the bypass and the prompt): a command
 *      that carries its own is kept as written, so a re-arm or takeover
 *      command printed from a running drive runs the same arguments it
 *      shows, whatever the configuration says by then. Those words are the
 *      running drive's own: its command line and the host's settings when it
 *      started.
 *
 * Words the pass command already carries as one run are not added twice:
 * the command `arm-drive.ts` builds already holds them. A pass command of
 * another tool ignores both settings and says so, and refuses `--pass-args`.
 * The permission mode is read from the command as it runs
 * (`--permission-mode X`, or `--dangerously-skip-permissions` for
 * `bypassPermissions`), and is `inherited` (Claude Code's own settings
 * decide) when the command sets none. A `codex` pass command's is read from
 * its own words the same way: `--dangerously-bypass-approvals-and-sandbox`,
 * which the arm and the dispatcher add for a host that set
 * `drive.codex_bypass`, a `--sandbox`, or `inherited` (Codex's configuration
 * decides).
 */
import { basename } from "node:path";
import { passVendor } from "./identity.ts";
import { CODEX_BYPASS } from "./pass-command.ts";
import {
  codexPassArgsSetting,
  DEFAULT_PASS_ARGS,
  passArgsSetting,
  refusedPassArgs,
} from "./overlay.ts";
import { DEFAULT_CODEX_PASS_ARGS } from "./codex-pass-args.ts";
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
    throw new PassArgsUsageError(
      `--pass-args ${refused} (its words follow drive.pass_args's rule)`,
    );
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

/** The words a Codex pass's configuration asks for: `drive.codex_pass_args`, else none. */
export function configuredCodexPassArgs(): PassArgs {
  const words = codexPassArgsSetting();
  return words === undefined
    ? {
        words: [...DEFAULT_CODEX_PASS_ARGS],
        source: "the default; drive.codex_pass_args is not set",
      }
    : { words, source: "drive.codex_pass_args" };
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

/** `argv` (a Codex pass command) with `words` before its prompt, its last word, unless it already carries them as one run. */
export function withCodexPassArgs(
  argv: readonly string[],
  words: readonly string[],
): string[] {
  if (carries(argv, words)) return [...argv];
  const at = Math.max(1, argv.length - 1);
  return [...argv.slice(0, at), ...words, ...argv.slice(at)];
}

/** Whether a `claude` pass command carries words beyond its model, `-p` and the prompt. */
function hasOwnArgs(argv: readonly string[]): boolean {
  const rest = withoutModel(argv).slice(1);
  return !(rest.length === 2 && rest.some((word) => PRINT.has(word)));
}

/** Whether a `codex` pass command carries words beyond `exec`, its model, the bypass and the prompt. */
function hasOwnCodexArgs(argv: readonly string[]): boolean {
  const rest = withoutModel(argv).slice(1);
  if (rest[0] !== "exec") return true;
  const middle = rest.slice(1, -1);
  return !(
    rest.length >= 2 &&
    (middle.length === 0 || (middle.length === 1 && middle[0] === CODEX_BYPASS))
  );
}

/**
 * Whether a printed re-arm or takeover command must carry `--pass-args ''`:
 * a Claude Code or Codex pass command with no arguments of its own. Whether
 * the empty list came from an override or from an unset `drive.pass_args`
 * or `drive.codex_pass_args` is not recoverable from the command, and the
 * configuration may change before the command runs (or be malformed now),
 * so the command says it itself rather than leaving the choice to a later
 * reading of the configuration.
 */
export function pinsEmptyPassArgs(argv: readonly string[]): boolean {
  if (argv[0] === undefined) return false;
  const vendor = passVendor(argv);
  if (vendor === "claude") return !hasOwnArgs(argv);
  return vendor === "codex" && !hasOwnCodexArgs(argv);
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

/** `--pass-args` on a pass command that is not Claude Code's: its words refused, an empty value kept as none. */
function refuseFlagWords(name: string, flag: string | undefined): void {
  if (flag !== undefined && parsePassArgsFlag(flag).length > 0)
    throw new PassArgsUsageError(
      `--pass-args applies to a Claude Code pass command (claude …); give '${name}' its arguments after --${name === "codex" ? ", or on the host in drive.codex_pass_args" : ""}`,
    );
}

/** A pass command of another tool: both settings ignored and said so, `--pass-args` refused. */
function otherPass(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassArgs,
  codex: () => PassArgs,
): EffectivePassArgs {
  const name = basename(argv[0] as string);
  refuseFlagWords(name, flag);
  let codexSet = false;
  try {
    codexSet = codex().words.length > 0;
  } catch {
    // This pass does not use the Codex-only setting.
  }
  const set = configured().words.length > 0 || codexSet;
  return {
    argv: [...argv],
    line: set
      ? `pass args: none; drive.pass_args applies to a Claude Code pass command and drive.codex_pass_args to a Codex one, and '${name}' ignores both`
      : `pass args: none (the pass command is ${name})`,
    permission: { mode: null, source: `chosen by the pass command (${name})` },
  };
}

/**
 * A Codex pass command: `drive.codex_pass_args` added before the prompt of
 * one with no arguments of its own, a command that carries its own kept as
 * written, `--pass-args`'s words refused and its empty value kept as none.
 * The line says when `drive.pass_args`, Claude Code's, is set and ignored.
 */
function codexPass(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassArgs,
  codex: () => PassArgs,
): EffectivePassArgs {
  refuseFlagWords("codex", flag);
  const done = (out: string[], line: string): EffectivePassArgs => ({
    argv: out,
    line,
    permission: codexPermission(out),
  });
  if (flag !== undefined)
    return done([...argv], "pass args: none (--pass-args)");
  if (hasOwnCodexArgs(argv)) {
    let chosen: PassArgs;
    let claude: string;
    try {
      chosen = codex();
      claude =
        configured().words.length > 0
          ? "; drive.pass_args applies to a Claude Code pass command"
          : "";
    } catch {
      return done(
        [...argv],
        "pass args: the pass command's own, kept as written",
      );
    }
    if (chosen.words.length > 0 && carries(argv, chosen.words))
      return done(
        [...argv],
        `pass args: ${shown(chosen.words)} (${chosen.source}, as written in the pass command)${claude}`,
      );
    return done(
      [...argv],
      chosen.words.length === 0
        ? `pass args: the pass command's own, kept as written${claude}`
        : `pass args: the pass command's own, kept as written; ${chosen.source} (${shown(chosen.words)}) is added only to a pass command without arguments of its own${claude}`,
    );
  }
  const chosen = codex();
  const claude =
    configured().words.length > 0
      ? "; drive.pass_args applies to a Claude Code pass command"
      : "";
  return done(
    withCodexPassArgs(argv, chosen.words),
    `pass args: ${shown(chosen.words)} (${chosen.source})${claude}`,
  );
}

function sandboxValue(argv: readonly string[], i: number): string | undefined {
  const word = argv[i] as string;
  if (word === "--sandbox" || word === "-s") return argv[i + 1];
  if (word.startsWith("--sandbox=")) return word.slice("--sandbox=".length);
  if (word.startsWith("-s"))
    return word.slice(2).replace(/^=/, "") || undefined;
  return undefined;
}

/**
 * How a `codex` pass command runs its commands: without a sandbox or
 * approvals (a host that set `drive.codex_bypass`), in the sandbox
 * `--sandbox` names, or as Codex's own configuration decides.
 */
export function codexPermission(argv: readonly string[]): PermissionMode {
  const end = argv.indexOf("--");
  const words = end === -1 ? argv : argv.slice(0, end);
  if (words.slice(1).some((w) => w === CODEX_BYPASS || w === "--yolo"))
    return {
      mode: "no sandbox, no approvals",
      source: `the pass command's ${CODEX_BYPASS}`,
    };
  for (let i = 1; i < words.length; i++) {
    const value = sandboxValue(words, i);
    if (value)
      return {
        mode: `sandbox ${value}`,
        source: "the pass command's --sandbox",
      };
  }
  return {
    mode: "inherited",
    source: "the pass command sets no --sandbox; Codex's configuration decides",
  };
}

/**
 * The pass command with its extra arguments decided (see the module
 * header), from the command as given (its model already decided), the
 * `--pass-args` flag and the configured words: Claude Code's
 * (`configured`) and Codex's (`codex`).
 */
export function effectivePassArgs(
  argv: readonly string[],
  flag: string | undefined,
  configured: () => PassArgs = configuredPassArgs,
  codex: () => PassArgs = configuredCodexPassArgs,
): EffectivePassArgs {
  if (argv[0] === undefined)
    return {
      argv: [],
      line: "pass args: no pass command given",
      permission: { mode: null, source: "no pass command given" },
    };
  const vendor = passVendor(argv);
  if (vendor === "codex") return codexPass(argv, flag, configured, codex);
  if (vendor !== "claude") return otherPass(argv, flag, configured, codex);
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
