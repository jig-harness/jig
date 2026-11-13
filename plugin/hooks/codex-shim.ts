#!/usr/bin/env bun
/**
 * The turn-budget guard as Codex runs it: a stable entry that hands the hook's
 * payload to the installed plugin copy's `turn-budget-guard.ts`.
 *
 * The problem. Codex trusts a hook it did not ship itself by the hash of its
 * definition, and trusts a plugin's hooks by the hash of the plugin's whole
 * contents as well, so a plugin hook asks for a new approval with every
 * release. `jig upgrade` therefore registers this entry in Codex's own
 * `hooks.json` instead (`runtime/codex-hook.ts`): its command line names this
 * file under the user's state directory and never changes, so one approval
 * stands across releases, while the guard it runs is whichever copy the
 * plugin installed last.
 *
 * Which copy. `jig upgrade` copies this file to `~/.local/state/jig/hooks/`
 * beside `turn-budget-guard.path`, one line naming the installed copy's guard.
 * The shim runs that guard with the payload on standard input and exits with
 * its status. A pointer that is missing, or names a guard that is gone, exits
 * 1 and says why on standard error, which Codex shows as a hook error: a
 * guard that is silent when it cannot run reads as checked and clear.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file beside the shim that names the installed copy's guard. */
export const POINTER = "turn-budget-guard.path";

function main(): number {
  const pointer = join(dirname(import.meta.path), POINTER);
  let guard: string;
  try {
    guard = readFileSync(pointer, "utf8").trim();
  } catch (error) {
    console.error(
      `jig turn-budget guard: cannot read ${pointer} (${error instanceof Error ? error.message : String(error)}); run \`jig upgrade --codex\``,
    );
    return 1;
  }
  const result = Bun.spawnSync([process.execPath, guard], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode === null) {
    console.error(
      `jig turn-budget guard: ${guard} did not run (${result.signalCode ?? "no exit status"}); run \`jig upgrade --codex\``,
    );
    return 1;
  }
  return result.exitCode;
}

if (import.meta.main) process.exitCode = main();
