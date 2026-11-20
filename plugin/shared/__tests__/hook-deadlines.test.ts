import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A git command that runs the repository's hooks (a commit, a merge that
 * completes, a continued rebase, a cherry-pick or revert, a push) runs for
 * as long as those hooks do, which Jig does not know. Through the command
 * wrapper with its 120-second default it is killed mid-hook in a repository
 * whose hooks are slow, so every such command a procedure prescribes passes
 * its own `--timeout-seconds`.
 */

const PLUGIN = join(import.meta.dir, "..", "..");

const WRAPPED_GIT = /command\.ts"?(.*?)\s--\s+git\s+(.*)$/;
const HOOK_RUNNING =
  /^(?:-c\s+\S+\s+)*(?:commit|merge|cherry-pick|revert|push|am|rebase\s+--continue)(?=[\s`'"]|$)/;
const NO_HOOKS = /\s--(?:abort|quit)\b/;

/** Each wrapped, hook-running git command on a line, without its deadline. */
function undeadlinedHookCommands(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    for (const call of line.split(
      /(?=bun\s+(?:--\S+\s+)*["']?[^\s"']*shared\/command\.ts)/,
    )) {
      const match = WRAPPED_GIT.exec(call);
      if (!match) continue;
      const [, options = "", rest = ""] = match;
      if (!HOOK_RUNNING.test(rest) || NO_HOOKS.test(rest)) continue;
      if (!/--timeout-seconds\s+\d+/.test(options)) found.push(call.trim());
    }
  }
  return found;
}

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sources(path));
    else if (/\.(?:md|ts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("hook-running commands carry a deadline", () => {
  test("the scanner finds a wrapped commit without one", () => {
    expect(
      undeadlinedHookCommands(
        'bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- git commit -F m.txt',
      ),
    ).toHaveLength(1);
    expect(
      undeadlinedHookCommands(
        'run `bun "<skill-dir>/../../shared/command.ts" --env GIT_EDITOR true -- git rebase --continue`, which',
      ),
    ).toHaveLength(1);
    expect(
      undeadlinedHookCommands(
        'bun "<skill-dir>/../../shared/command.ts" -- git -c merge.conflictStyle=zdiff3 merge origin/main',
      ),
    ).toHaveLength(1);
  });

  test("the scanner passes a deadline and commands that run no hook", () => {
    for (const line of [
      'bun "${CLAUDE_SKILL_DIR}/../../shared/command.ts" --timeout-seconds 3600 -- git commit -F m.txt',
      'bun "<skill-dir>/../../shared/command.ts" --timeout-seconds 3600 --env GIT_EDITOR true -- git rebase --continue',
      'bun "<skill-dir>/../../shared/command.ts" -- git merge --abort',
      'bun "<skill-dir>/../../shared/command.ts" -- git merge-tree --write-tree a b',
      'bun "<skill-dir>/../../shared/command.ts" -- git commit-tree x',
      'bun "<skill-dir>/../../shared/command.ts" -- git log -1',
      'bun "<skill-dir>/../../shared/command.ts" -- git clean -f -- conflict-message.txt',
    ])
      expect(undeadlinedHookCommands(line)).toEqual([]);
  });

  test("every plugin document and script prescribes one", () => {
    const offenders: string[] = [];
    for (const file of sources(PLUGIN))
      for (const call of undeadlinedHookCommands(readFileSync(file, "utf8")))
        offenders.push(`${relative(PLUGIN, file)}: ${call}`);
    expect(offenders).toEqual([]);
  });
});
