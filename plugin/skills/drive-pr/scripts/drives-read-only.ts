#!/usr/bin/env bun
/**
 * drives-read-only.ts — read one lock or list drive diagnoses for a reader
 * (`jig ask`), which must never choose when the drive's database migrates.
 *
 * Opening the drive's database creates it, migrates its schema and reads the
 * clone's state directory into it, and the listing opens it. So this lists
 * only a database that is already current. Its doctor mode includes retained
 * blockers. Lock-only mode reads just the named PR's driver claim.
 * Both use a read-only connection (`READ_ONLY_ENV`), so a change after the
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
import { readLock } from "./lib/lock-listing.ts";
import { driveDbReadiness, READ_ONLY_ENV } from "./lib/state/db.ts";
import { peekResolvedStateDir } from "./lib/state/store.ts";

const DRIVES = join(import.meta.dir, "drives.ts");

const EMPTY = { empty: true } as const;

/** What to do with the clone's listing: run it, print it empty, or decline with the reason. */
function verdict(
  stateDir: string,
): { stateDir: string } | { empty: true } | { decline: string } {
  const ready = driveDbReadiness(stateDir);
  if (ready.state === "absent") return EMPTY;
  return ready.state === "current" ? { stateDir } : { decline: ready.reason };
}

function requireJson(argv: string[]): void {
  if (
    argv[0] !== "--json" ||
    !(
      argv.length === 1 ||
      (argv.length === 3 &&
        argv[1] === "--pr" &&
        /^[1-9][0-9]*$/.test(argv[2] ?? ""))
    )
  )
    fail(2, "usage: drives-read-only.ts --json [--pr N]");
}

function listingArgs(argv: string[]): { args: string[]; lockPr?: string } {
  if (argv[0] !== "--lock-only") {
    requireJson(argv);
    return { args: argv };
  }
  const args = argv.slice(1);
  requireJson(args);
  const lockPr = args[2];
  if (lockPr === undefined) fail(2, "--lock-only requires --json --pr N");
  return { args, lockPr };
}

/** This command opens the database read-only, including after the readiness check. */
function printLock(stateDir: string, pr: string): number {
  process.env[READ_ONLY_ENV] = "1";
  console.log(
    JSON.stringify({ stateDir, rows: [readLock(stateDir, "pr", pr)] }),
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { args, lockPr } = listingArgs(argv);
  const stateDir = await peekResolvedStateDir();
  const v = stateDir === null ? EMPTY : verdict(stateDir);
  if (!("stateDir" in v)) return printUnavailable(v, stateDir);
  return lockPr === undefined ? runDoctor(args) : printLock(v.stateDir, lockPr);
}

function printUnavailable(
  result: { empty: true } | { decline: string },
  stateDir: string | null,
): number {
  if ("empty" in result) {
    console.log(JSON.stringify({ stateDir, rows: [] }, null, 2));
    return 0;
  }
  console.error(`drives-read-only.ts: ${result.decline}`);
  return 4;
}

function runDoctor(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, DRIVES, "--doctor", ...args], {
    stdin: "ignore",
    env: { ...process.env, [READ_ONLY_ENV]: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main)
  runMain("drives-read-only.ts", () => main(process.argv.slice(2)));
