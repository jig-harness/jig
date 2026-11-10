/**
 * Runs `runPreflight` in its own process, so a test sets the deadline
 * variable in that process's environment and never in the test runner's.
 *
 * Usage: bun preflight-runner.ts <command>
 * Prints the result as JSON.
 */
import { runPreflight } from "../../scripts/lib/preflight.ts";

const result = await runPreflight(
  process.cwd(),
  process.argv[2] ?? "",
  JSON.stringify({ found: true, identifier: "#5" }),
);
console.log(JSON.stringify(result));
