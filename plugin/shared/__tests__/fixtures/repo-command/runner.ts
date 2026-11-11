/**
 * Runs the repository-command runner in its own process, so a test sets
 * variables in that process's environment and never in the test runner's.
 *
 * Usage:
 *   bun runner.ts run <cwd> <timeout-sec> <command>
 *   bun runner.ts setting <root> <section> <field>
 *   bun runner.ts settings <root> <section> <field>,<field>...
 * Prints the result as JSON.
 */
import {
  defaultBranchSetting,
  defaultBranchSettings,
  runRepoCommand,
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
else if (mode === "settings")
  console.log(
    JSON.stringify(
      await defaultBranchSettings(a ?? ".", b ?? "", (c ?? "").split(",")),
    ),
  );
else
  console.log(
    JSON.stringify(await defaultBranchSetting(a ?? ".", b ?? "", c ?? "")),
  );
