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
/** The skill-directory variable as a `SKILL.md` writes it. */
const SKILL_DIR = "$" + "{CLAUDE_SKILL_DIR}";

/** Where a command's own arguments end on a line of prose or shell. */
const ENDS = new Set(["`", ";", "|", "&", ")"]);
/** Wrapper options and how many words each takes (`command.ts`'s usage). */
const WRAPPER_ARITY = new Map([
  ["--env", 2],
  ["--stdin-file", 1],
  ["--input", 1],
  ["--stdout-file", 1],
  ["--output", 1],
  ["--stdout-exit-code", 1],
  ["--cwd", 1],
  ["--timeout-seconds", 1],
  ["--unset-prefix", 1],
]);
/** Git's global options that take their value as the next word. */
const GIT_VALUE_OPTIONS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);
const HOOK_SUBCOMMANDS = new Set([
  "commit",
  "merge",
  "cherry-pick",
  "revert",
  "push",
  "pull",
  "am",
  "rebase",
  "reset",
]);
/** Subcommands whose leading `--abort` or `--quit` runs no hook. */
const ENDING_SUBCOMMANDS = new Set([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
]);

/** The words of a command from `start`, quotes removed, up to where it ends. */
function words(text: string, start: number): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (ENDS.has(c)) break;
    else if (/\s/.test(c)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) out.push(word);
  return out;
}

/** Whether the wrapped git command runs hooks and the wrapper gave no deadline. */
function lacksDeadline(args: string[]): boolean {
  let i = 0;
  let deadline = false;
  while (args[i]?.startsWith("--") && args[i] !== "--") {
    const option = args[i++] as string;
    const arity = WRAPPER_ARITY.get(option);
    if (arity === undefined) return false;
    if (option === "--timeout-seconds" && /^\d+$/.test(args[i] ?? ""))
      deadline = true;
    i += arity;
  }
  if (args[i] === "--") i++;
  if (args[i] !== "git") return false;
  i++;
  while (i < args.length && args[i]?.startsWith("-")) {
    const option = args[i++] as string;
    if (GIT_VALUE_OPTIONS.has(option)) i++;
  }
  const subcommand = args[i] ?? "";
  if (!HOOK_SUBCOMMANDS.has(subcommand)) return false;
  const rest = args.slice(i + 1);
  if (
    ENDING_SUBCOMMANDS.has(subcommand) &&
    (rest[0] === "--abort" || rest[0] === "--quit")
  )
    return false;
  if (subcommand === "rebase" && rest[0] !== "--continue") return false;
  return !deadline;
}

/** Each wrapped, hook-running git command in a text, without its deadline. */
function undeadlinedHookCommands(text: string): string[] {
  const found: string[] = [];
  const joined = text.replace(/\\\r?\n\s*/g, " ");
  for (const match of joined.matchAll(/shared\/command\.ts["']?/g)) {
    const start = match.index + match[0].length;
    if (lacksDeadline(words(joined, start)))
      found.push(joined.slice(match.index, start + 80).split("\n")[0] ?? "");
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
        `bun "${SKILL_DIR}/../../shared/command.ts" -- git commit -F m.txt`,
      ),
    ).toHaveLength(1);
    expect(
      undeadlinedHookCommands(
        'run `bun "<skill-dir>/../../shared/command.ts" --env GIT_EDITOR true -- git rebase --continue`, which',
      ),
    ).toHaveLength(1);
    for (const line of [
      'bun "<skill-dir>/../../shared/command.ts" -- git -c merge.conflictStyle=zdiff3 merge origin/main',
      'bun "<skill-dir>/../../shared/command.ts" -- git -C sub commit -m x',
      'bun "<skill-dir>/../../shared/command.ts" -- git --no-pager pull',
      'merge with `bun "<skill-dir>/../../shared/command.ts" -- git merge main`, or `git merge --abort` it',
      'bun "x/shared/command.ts" git commit -m x',
      'bun "x/shared/command.ts" -- git --git-dir .git commit -m x',
      'bun "x/shared/command.ts" --env NOTE "--timeout-seconds 3600" -- git commit -m x',
      'bun "x/shared/command.ts" -- git commit -m "document --abort behavior"',
      'bun "x/shared/command.ts" -- git commit -m "document --quit behavior"',
      'bun "x/shared/command.ts" -- git reset --merge',
      "bun 'x/shared/command.ts' -- git commit -F m.txt",
      'bun "x/shared/command.ts" -- git merge -m "--abort" main',
      'bun "x/shared/command.ts" -- git merge -m "--quit" main',
      'bun "x/shared/command.ts" \\\n  -- git commit -F m.txt',
    ])
      expect(undeadlinedHookCommands(line)).toHaveLength(1);
  });

  test("the scanner passes a deadline and commands that run no hook", () => {
    for (const line of [
      `bun "${SKILL_DIR}/../../shared/command.ts" --timeout-seconds 3600 -- git commit -F m.txt`,
      'bun "<skill-dir>/../../shared/command.ts" --timeout-seconds 3600 --env GIT_EDITOR true -- git rebase --continue',
      'bun "<skill-dir>/../../shared/command.ts" -- git merge --abort',
      'bun "<skill-dir>/../../shared/command.ts" -- git merge-tree --write-tree a b',
      'bun "<skill-dir>/../../shared/command.ts" -- git commit-tree x',
      'bun "<skill-dir>/../../shared/command.ts" -- git log -1',
      'bun "<skill-dir>/../../shared/command.ts" -- git clean -f -- conflict-message.txt',
      'bun "<skill-dir>/../../shared/command.ts" -- git merge-base --is-ancestor a HEAD',
      'bun "<skill-dir>/../../shared/command.ts" -- git rebase --quit',
      'bun "x/shared/command.ts" --timeout-seconds 3600 -- git reset --merge',
    ])
      expect(undeadlinedHookCommands(line)).toEqual([]);
  });

  test("every command line the plugin's documents and scripts write has one", () => {
    const offenders: string[] = [];
    for (const file of sources(PLUGIN))
      for (const call of undeadlinedHookCommands(readFileSync(file, "utf8")))
        offenders.push(`${relative(PLUGIN, file)}: ${call}`);
    expect(offenders).toEqual([]);
  });
});
