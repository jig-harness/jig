#!/usr/bin/env bun
/**
 * Hand a newly filed issue to the line: assign it to a tracker identity (a
 * served person) once the tracker's history records the assignment.
 *
 * Usage:
 *     bun hand-off.ts <issue-key> --to <identity> [--no-wait]
 *
 * On a tracker whose history leaves out changes made just after an issue's
 * creation (Linear: its first three minutes), the assignment is written
 * only once that window has passed: the script waits for it, or with
 * `--no-wait` says from when the hand-off may run. An issue already
 * assigned is never changed.
 *
 * Prints one JSON object (`lib/hand-off.ts`'s `HandOff`). Exit 0: handed
 * over (written now, or already there with its history showing it); 3: not
 * handed over, with the reason, the earliest time to run it again when that
 * is what it waits on, and the remedy; 2: usage.
 */
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import { handOff } from "./lib/hand-off.ts";

const USAGE = "usage: hand-off.ts <issue-key> --to <identity> [--no-wait]";
const OPTIONS = {
  allowPositionals: true,
  options: {
    to: { type: "string" },
    "no-wait": { type: "boolean" },
  },
} as const;

async function main(argv: string[]): Promise<number> {
  const { key, to, wait } = parse(argv);
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.once(sig, () => stop.abort());
  // The tracker's transport stops on the CLI's signal or the hand-off's deadline.
  const operation = new AbortController();
  stop.signal.addEventListener(
    "abort",
    () => operation.abort(stop.signal.reason),
    { once: true },
  );
  const result = await handOff(
    openTracker(undefined, undefined, operation.signal),
    key,
    to,
    { wait, signal: stop.signal, operation },
  );
  console.log(JSON.stringify(result, null, 2));
  return result.handedOver ? 0 : 3;
}

/** The issue key, the identity and whether to wait; a malformed command line exits 2. */
function parse(argv: string[]): { key: string; to: string; wait: boolean } {
  let parsed: ReturnType<typeof parseArgs<typeof OPTIONS>>;
  try {
    parsed = parseArgs({ args: argv, ...OPTIONS });
  } catch (error) {
    fail(2, error instanceof Error ? error.message : String(error), USAGE);
  }
  const { values, positionals } = parsed;
  const [key, ...extra] = positionals;
  if (key === undefined || extra.length > 0)
    fail(2, "name exactly one issue key", USAGE);
  const to = values.to?.trim();
  if (to === undefined || to === "")
    fail(2, "--to names the identity to hand the issue to", USAGE);
  return { key, to, wait: values["no-wait"] !== true };
}

if (import.meta.main) runMain("hand-off", () => main(process.argv.slice(2)));

export { main, parse };
