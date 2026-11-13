/**
 * The turn-budget guard in Codex: one `PreToolUse` entry in the Codex home's
 * own `hooks.json`, whose command line never changes.
 *
 * Codex asks for a new approval of a plugin's hooks whenever the plugin's
 * contents change, which is every release, and skips them until then. A hook
 * in the user's `hooks.json` is trusted by the hash of its definition alone,
 * so the plugin ships none to Codex (`.codex-plugin/plugin.json` names an empty
 * hooks file) and `jig upgrade` registers this one instead: its command runs
 * `hooks/codex-shim.ts`, copied to `~/.local/state/jig/hooks/`, which runs the
 * guard of the installed plugin copy named in a pointer file written beside
 * it. A release moves the pointer; the definition stays, and one approval
 * (`/hooks` in Codex) stands.
 *
 * The refresh adds the entry as the last `PreToolUse` group, so the trust
 * records Codex keys by group position for the other hooks keep their place,
 * and changes nothing else in the file. A file that is not JSON is left as it
 * is and reported. A host that rewrites the file (a workspace app that
 * manages it) loses the entry until the next refresh writes it again.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMapping as isRecord } from "../shared/config-layers.ts";
import { errnoCode } from "../shared/errors.ts";
import { attempt, failed, ok, type Outcome } from "../shared/outcome.ts";
import { renameWithRetry } from "../shared/rename-with-retry.ts";
import { POINTER } from "../hooks/codex-shim.ts";
import type { RefreshResult } from "./refresh.ts";

/** The shim's file name, which marks a handler as this entry. */
const SHIM = "codex-turn-budget-guard.ts";

/** Words Codex shows beside the hook while it runs. */
const STATUS_MESSAGE = "Counting this session's agentic turns";

/** The hook's time limit in seconds, the one the plugin's hook declared. */
const TIMEOUT_SECONDS = 15;

/** Where the shim and its pointer live, outside every plugin release. */
function hookDirectory(home = homedir()): string {
  return join(home, ".local", "state", "jig", "hooks");
}

/** The Codex home: `CODEX_HOME`, else `~/.codex`. */
function codexHome(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return env.CODEX_HOME || join(home, ".codex");
}

/** The command line the entry runs: Bun on the shim at `shim`. */
export function hookCommand(shim: string): string {
  return `bun "${shim}"`;
}

type Document = Record<string, unknown>;

function handlerOf(command: string): Document {
  return {
    type: "command",
    command,
    timeout: TIMEOUT_SECONDS,
    statusMessage: STATUS_MESSAGE,
  };
}

function isOurs(handler: unknown): handler is Document {
  return (
    isRecord(handler) &&
    typeof handler.command === "string" &&
    handler.command.includes(SHIM)
  );
}

function groupsOf(document: Document): unknown[] | null {
  const hooks = document.hooks;
  if (hooks === undefined) return [];
  if (!isRecord(hooks)) return null;
  const groups = hooks.PreToolUse;
  if (groups === undefined) return [];
  return Array.isArray(groups) ? groups : null;
}

function handlersOf(group: unknown): unknown[] {
  return isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [];
}

/**
 * `document` with this entry registered: an existing handler of ours is
 * brought to `command` and the definition this release declares, and when
 * there is none a group holding it is appended. `null` when the document has
 * a shape the entry cannot be added to. The input is not changed.
 */
export function withHook(document: unknown, command: string): Document | null {
  if (!isRecord(document)) return null;
  const groups = groupsOf(document);
  if (groups === null) return null;
  const next = structuredClone(document) as Document;
  const found = groups.some((group) => handlersOf(group).some(isOurs));
  const rewritten = found
    ? groups.map((group) =>
        isRecord(group) && handlersOf(group).some(isOurs)
          ? {
              ...group,
              hooks: handlersOf(group).map((handler) =>
                isOurs(handler)
                  ? { ...handler, ...handlerOf(command) }
                  : handler,
              ),
            }
          : group,
      )
    : [...groups, { hooks: [handlerOf(command)] }];
  next.hooks = {
    ...(isRecord(next.hooks) ? next.hooks : {}),
    PreToolUse: rewritten,
  };
  return next;
}

/**
 * `document` without this entry: its handlers go, a group left with none goes
 * with them, and an event left with no group is dropped. `null` when the
 * document has a shape the entry cannot be in.
 */
export function withoutHook(document: unknown): Document | null {
  if (!isRecord(document)) return null;
  const groups = groupsOf(document);
  if (groups === null) return null;
  if (!groups.some((group) => handlersOf(group).some(isOurs)))
    return structuredClone(document) as Document;
  const kept = groups.flatMap((group) => {
    if (!isRecord(group) || !handlersOf(group).some(isOurs)) return [group];
    const handlers = handlersOf(group).filter((handler) => !isOurs(handler));
    return handlers.length === 0 ? [] : [{ ...group, hooks: handlers }];
  });
  const next = structuredClone(document) as Document;
  const { PreToolUse: _removed, ...events } = next.hooks as Document;
  next.hooks = kept.length === 0 ? events : { ...events, PreToolUse: kept };
  return next;
}

/** The parsed file, `{}` when there is none, or why it cannot be used. */
function readDocument(path: string): Outcome<unknown, "unreadable"> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return ok({});
    return failed("unreadable", `cannot read ${path}: ${String(error)}`, error);
  }
  if (text.trim() === "") return ok({});
  return attempt("unreadable", `${path} is not JSON`, () => JSON.parse(text));
}

function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.jig-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameWithRetry(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function render(document: Document): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The text of `path`, or null when there is no file. */
function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Where the installed copy's files are and where the entry is registered. */
export interface HookPlaces {
  /** The Codex home whose `hooks.json` holds the entry. */
  codexHome?: string;
  /** The directory the shim and its pointer are written to. */
  directory?: string;
  /** The installed plugin copy's `hooks/` directory. */
  pluginHooks?: string;
}

const PLUGIN_HOOKS = join(import.meta.dir, "..", "hooks");

/**
 * Registers the guard in the Codex home's `hooks.json`, and writes what its
 * command runs: the shim, and the pointer to this plugin copy's guard.
 * Nothing is written where nothing differs, and a Codex home that does not
 * exist, as on a machine without Codex, is left alone.
 */
export function refreshCodexHook(places: HookPlaces = {}): RefreshResult {
  const target = "codex turn-budget hook";
  const result = (
    outcome: RefreshResult["outcome"],
    detail: string,
  ): RefreshResult => ({ target, outcome, detail });
  const home = places.codexHome ?? codexHome();
  const directory = places.directory ?? hookDirectory();
  const pluginHooks = places.pluginHooks ?? PLUGIN_HOOKS;
  if (!existsSync(home)) return result("skipped", `no Codex home at ${home}`);
  try {
    const hooksFile = join(home, "hooks.json");
    const shim = join(directory, SHIM);
    const pointer = join(directory, POINTER);
    const guard = join(pluginHooks, "turn-budget-guard.ts");
    const read = readDocument(hooksFile);
    if (!read.ok) return result("failed", read.failure.reason);
    const document = withHook(read.value, hookCommand(shim));
    if (document === null)
      return result(
        "failed",
        `${hooksFile} has hooks the entry cannot be added to (hooks.PreToolUse is not a list)`,
      );
    const wrote: string[] = [];
    const source = join(pluginHooks, "codex-shim.ts");
    if (readOptional(shim) !== readFileSync(source, "utf8")) {
      mkdirSync(directory, { recursive: true });
      copyFileSync(source, shim);
      wrote.push(`copied the shim to ${shim}`);
    }
    if (readOptional(pointer) !== `${guard}\n`) {
      writeAtomically(pointer, `${guard}\n`);
      wrote.push(`pointed ${pointer} at ${guard}`);
    }
    if (readOptional(hooksFile) !== render(document)) {
      writeAtomically(hooksFile, render(document));
      wrote.push(
        `registered the hook in ${hooksFile}; approve it once with /hooks in Codex`,
      );
    }
    return wrote.length === 0
      ? result("unchanged", "the entry, its shim and its pointer are current")
      : result("refreshed", wrote.join("; "));
  } catch (error) {
    return result(
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Takes the entry out of the Codex home's `hooks.json` and removes the shim's
 * directory, leaving every other hook as it was. Reports in words what it
 * did, or would do without `confirm`.
 */
export function removeCodexHook(
  options: { confirm: boolean } & HookPlaces,
): string {
  const home = options.codexHome ?? codexHome();
  const directory = options.directory ?? hookDirectory();
  const hooksFile = join(home, "hooks.json");
  const read = existsSync(hooksFile) ? readDocument(hooksFile) : ok({});
  if (!read.ok) return `The Codex hook: ${read.failure.reason}`;
  const without = withoutHook(read.value);
  if (without === null)
    return `The Codex hook: ${hooksFile} has hooks the entry cannot be in, and stays`;
  const registered =
    existsSync(hooksFile) && render(without) !== render(read.value as Document);
  if (options.confirm) {
    try {
      if (registered) writeAtomically(hooksFile, render(without));
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      return `The Codex hook: could not be removed (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return registered
    ? `The Codex hook: the entry in ${hooksFile} is removed`
    : `The Codex hook: no entry in ${hooksFile}`;
}
