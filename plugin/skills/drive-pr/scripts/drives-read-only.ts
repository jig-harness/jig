#!/usr/bin/env bun
/**
 * drives-read-only.ts — `drives.ts --doctor --json` for a reader that is not a driver
 * (`jig ask`), which must never choose when the drive's database migrates.
 *
 * Opening the drive's database creates it, migrates its schema and reads the
 * clone's state directory into it, and the listing opens it. So this lists
 * only a database that is already current, including lock-less retained blockers, by running `drives.ts --doctor --json`
 * over a read-only connection (`READ_ONLY_ENV`), so a change after the
 * readiness check cannot make the listing write, and otherwise writes nothing:
 *
 *   - no clone identity, or no database yet: no drive was ever started here,
 *     and the rows are empty;
 *   - a database a driver's next run must first bring forward (an older
 *     schema, or this clone's state directory not read in yet), or one a
 *     newer plugin wrote: exit 4, the reason on stderr, nothing on stdout.
 *
 * Exit codes: `drives.ts`'s own for a listing it ran; 2 usage; 4 declined.
 */
import { join } from "node:path";
import { fail, runMain } from "./lib/cli.ts";
import { driveDbReadiness, READ_ONLY_ENV } from "./lib/state/db.ts";
import { peekResolvedStateDir } from "./lib/state/store.ts";

const DRIVES = join(import.meta.dir, "drives.ts");

const EMPTY = { empty: true } as const;

/** What to do with the clone's listing: run it, print it empty, or decline with the reason. */
function verdict(
  stateDir: string,
): { run: true } | { empty: true } | { decline: string } {
  const ready = driveDbReadiness(stateDir);
  if (ready.state === "absent") return EMPTY;
  return ready.state === "current" ? { run: true } : { decline: ready.reason };
}

function requireJson(argv: string[]): void {
  if (argv.length !== 1 || argv[0] !== "--json")
    fail(2, "usage: drives-read-only.ts --json");
}

async function main(argv: string[]): Promise<number> {
  requireJson(argv);
  const stateDir = await peekResolvedStateDir();
  const v = stateDir === null ? EMPTY : verdict(stateDir);
  if ("empty" in v) {
    console.log(JSON.stringify({ stateDir, rows: [] }, null, 2));
    return 0;
  }
  if ("decline" in v) {
    console.error(`drives-read-only.ts: ${v.decline}`);
    return 4;
  }
  const child = Bun.spawn([process.execPath, DRIVES, "--doctor", "--json"], {
    stdin: "ignore",
    env: { ...process.env, [READ_ONLY_ENV]: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main)
  runMain("drives-read-only.ts", () => main(process.argv.slice(2)));
