/**
 * Runs the repository-command runner in its own process, so a test sets
 * variables in that process's environment and never in the test runner's.
 *
 * Usage:
 *   bun runner.ts run <cwd> <timeout-sec> <command>
 *   bun runner.ts setting <root> <section> <field>
 *   bun runner.ts settings <root> <section> <field>,<field>...
 *   bun runner.ts tree <root> <commit>
 * Prints the result as JSON.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultBranchSetting,
  defaultBranchSettings,
  runRepoCommand,
  withDefaultBranchTree,
} from "../../../repo-command.ts";

const [mode, a, b, c] = process.argv.slice(2);
if (mode === "run")
  console.log(
    JSON.stringify(
      await runRepoCommand({
        cwd: a ?? ".",
        timeoutSec: Number(b),
        command: c ?? "",
        stdin: "input",
        name: "the command",
      }),
    ),
  );
else if (mode === "tree") {
  let dir = "";
  const out = await withDefaultBranchTree(a ?? ".", b ?? "", async (tree) => {
    dir = tree;
    return {
      files: readdirSync(tree).sort(),
      note: readFileSync(join(tree, "note.txt"), "utf8"),
    };
  });
  console.log(
    JSON.stringify({ out, dir, removed: dir !== "" && !existsSync(dir) }),
  );
} else if (mode === "settings")
  console.log(
    JSON.stringify(
      await defaultBranchSettings(a ?? ".", b ?? "", (c ?? "").split(",")),
    ),
  );
else
  console.log(
    JSON.stringify(await defaultBranchSetting(a ?? ".", b ?? "", c ?? "")),
  );
