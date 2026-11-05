/**
 * reap-state.test.ts — the sweep of the files a clone's state directory keeps
 * beside the drive's database.
 *
 * Retiring a family too EARLY deletes a live drive's log or kept answers, so
 * every fail-closed branch gets its own test with the gate genuinely
 * unsatisfiable (a `gh` that errors, a lease that is live, an mtime inside the
 * guard, an import inside its retention). Retiring too LATE costs one more
 * weekly run.
 *
 * `gh` is a real executable on a scratch PATH rather than a mocked module:
 * `ghCall` is a deliberate chokepoint with its own guardrail test asserting
 * every outbound call goes through it.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { DB_FILE } from "../scripts/lib/state/db.ts";
import { leaseRef } from "../scripts/lib/state/lease.ts";
import { IMPORTED_RETENTION_DAYS, parseArgs } from "../scripts/reap-state.ts";
import { ACTOR } from "./drive-pr-harness.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { putLease } from "./state-rows.ts";

const REAP = join(import.meta.dir, "..", "scripts", "reap-state.ts");
const DAY_MS = 86_400_000;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "reap-state-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function stateDir(): string {
  const dir = scopedStateDir(join(root, `state-${++n}`));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A scratch PATH whose `gh pr view` answers `state` for every PR, or fails. */
function ghShim(name: string, answer: string | null): string {
  const dir = join(root, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFakeProgram(
    join(dir, "gh"),
    answer === null
      ? "#!/bin/sh\necho 'HTTP 502: bad gateway' >&2\nexit 1\n"
      : `#!/bin/sh\necho '{"state":"${answer}"}'\n`,
  );
  return dir;
}

function env(dir: string, ghDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k.startsWith("DRIVE_PR_") || v === undefined)
      continue;
    out[k] = v;
  }
  return {
    ...out,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    DRIVE_PR_STATE_DIR: dir,
    PATH: `${ghDir}${delimiter}${process.env.PATH ?? ""}`,
  };
}

function reap(dir: string, ghDir: string, args: string[] = []) {
  const result = Bun.spawnSync([process.execPath, REAP, "--json", ...args], {
    env: env(dir, ghDir),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    result,
    report: () =>
      JSON.parse(result.stdout.toString()) as {
        retire: { id: string; reason: string }[];
        keep: { id: string; reason: string }[];
        entriesRemoved: number;
        untouched: { unrecognised: number };
        failures: string[];
      },
  };
}

/** Write a PR's log and kept answers, aged `days` days. */
function prFiles(dir: string, pr: string, days: number): string[] {
  const names = [`drive-pr-${pr}.log`, `drive-pr-${pr}.answers.json`];
  const when = (Date.now() - days * DAY_MS) / 1000;
  for (const name of names) {
    writeFileSync(join(dir, name), "x");
    utimesSync(join(dir, name), when, when);
  }
  return names;
}

describe("reap-state.ts — a PR's files", () => {
  it("retires a merged PR's idle files, and only with --delete", () => {
    const dir = stateDir();
    const files = prFiles(dir, "999", 30);
    const gh = ghShim("merged", "MERGED");
    const dry = reap(dir, gh);
    expectSpawnExit(dry.result, 0);
    expect(dry.report().retire.map((r) => r.id)).toEqual(["pr:999"]);
    for (const f of files) expect(existsSync(join(dir, f))).toBe(true);
    const wet = reap(dir, gh, ["--delete"]);
    expectSpawnExit(wet.result, 0);
    expect(wet.report().entriesRemoved).toBe(2);
    for (const f of files) expect(existsSync(join(dir, f))).toBe(false);
  });

  it("keeps an open PR's, a closed-but-unmerged PR's and an unreadable PR's files", () => {
    for (const [answer, reason] of [
      ["OPEN", "open"],
      ["CLOSED", "can be reopened"],
      [null, "could not be read"],
    ] as const) {
      const dir = stateDir();
      prFiles(dir, "999", 30);
      const run = reap(dir, ghShim(`keep-${answer}`, answer), ["--delete"]);
      expectSpawnExit(run.result, 0);
      expect(run.report().retire).toEqual([]);
      expect(run.report().keep[0]?.reason).toContain(reason);
      expect(existsSync(join(dir, "drive-pr-999.log"))).toBe(true);
    }
  });

  it("keeps a merged PR's files while a lease is live on it", () => {
    const dir = stateDir();
    prFiles(dir, "999", 30);
    putLease(leaseRef(dir, "999", ACTOR), {});
    const run = reap(dir, ghShim("merged-leased", "MERGED"), ["--delete"]);
    expect(run.report().keep[0]?.reason).toContain("live session lease");
    expect(existsSync(join(dir, "drive-pr-999.log"))).toBe(true);
  });

  it("keeps a merged PR's files touched within --min-age-days", () => {
    const dir = stateDir();
    prFiles(dir, "999", 2);
    const run = reap(dir, ghShim("merged-recent", "MERGED"), [
      "--delete",
      "--min-age-days",
      "3",
    ]);
    expect(run.report().keep[0]?.reason).toContain("last 3 day(s)");
    expect(existsSync(join(dir, "drive-pr-999.log"))).toBe(true);
  });

  it("never removes a name it does not recognise", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "notes-a-person-left.txt"), "keep me");
    const run = reap(dir, ghShim("merged-unknown", "MERGED"), ["--delete"]);
    expect(run.report().untouched.unrecognised).toBe(1);
    expect(existsSync(join(dir, "notes-a-person-left.txt"))).toBe(true);
  });
});

describe("reap-state.ts — the files an earlier release kept", () => {
  function earlier(dir: string): string[] {
    const names = ["drive-pr-999.json", `pr-drive-lease-999-${ACTOR}.json`];
    writeFileSync(join(dir, names[0] as string), "{}");
    writeFileSync(join(dir, names[1] as string), "{}");
    mkdirSync(
      join(dir, "drive-pr-999.json.lock.stale.owner.0123456789abcdef01234567"),
    );
    return names;
  }

  /** Set when the database imported the clone's directory. */
  function importedDaysAgo(dir: string, days: number): void {
    const db = new Database(join(dirname(dir), DB_FILE));
    try {
      db.run("UPDATE imports SET at = ? WHERE clone = ?", [
        new Date(Date.now() - days * DAY_MS).toISOString(),
        basename(dir),
      ]);
    } finally {
      db.close();
    }
  }

  it("keeps them within the import's retention, and retires them after it", () => {
    const dir = stateDir();
    const names = earlier(dir);
    const gh = ghShim("open", "OPEN");
    const within = reap(dir, gh, ["--delete"]);
    expectSpawnExit(within.result, 0);
    expect(within.report().keep.map((k) => k.id)).toEqual([
      `imported:${basename(dir)}`,
    ]);
    for (const name of names) expect(existsSync(join(dir, name))).toBe(true);
    importedDaysAgo(dir, IMPORTED_RETENTION_DAYS + 1);
    const after = reap(dir, gh, ["--delete"]);
    expectSpawnExit(after.result, 0);
    expect(after.report().retire.map((r) => r.id)).toEqual([
      `imported:${basename(dir)}`,
    ]);
    // The lease file is not a lease, so the import skipped it: it stays.
    const [state, lease] = names as [string, string];
    expect(existsSync(join(dir, state))).toBe(false);
    expect(existsSync(join(dir, lease))).toBe(true);
  });

  it("creates nothing in a dry run", () => {
    const dir = stateDir();
    earlier(dir);
    const before = existsSync(join(dirname(dir), DB_FILE));
    expectSpawnExit(reap(dir, ghShim("open", "OPEN"), []).result, 0);
    expect(existsSync(join(dirname(dir), DB_FILE))).toBe(before);
  });
});

describe("reap-state.ts arguments", () => {
  it("bounds --min-age-days", () => {
    expect(parseArgs(["--min-age-days", "3"]).minAgeDays).toBe(3);
    for (const bad of ["0", "366", "x", "9".repeat(400)]) {
      const run = Bun.spawnSync(
        [process.execPath, REAP, "--min-age-days", bad],
        { stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(run, 2);
    }
  });
});
