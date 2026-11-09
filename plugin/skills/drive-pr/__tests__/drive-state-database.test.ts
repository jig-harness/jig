/**
 * The drive's database (`scripts/lib/state/db.ts`) through the real
 * `drive-state.ts`: a command killed inside its locked section leaves the
 * last committed state and a lock the next command recovers at once; two
 * commands at once serialize on the database and leave no file behind; a
 * clone's folder from a release that kept files is imported once, with its
 * rounds, parks and leases; a database a newer copy migrated is read when its
 * minimum reader allows and refused, naming the versions, when it does not;
 * a takeover raises the lease generation, and a pass whose lease was taken
 * over is refused its post.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { RECORD_KINDS } from "../../../shared/records/registry.ts";
import { DB_FILE, DRIVE_DB_VERSION } from "../scripts/lib/state/db.ts";
import { isFormerFile } from "../scripts/lib/state/import.ts";
import { leaseRef } from "../scripts/lib/state/lease.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { ACTOR } from "./drive-pr-harness.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { lockNames, readLease, readState, writeState } from "./state-rows.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const DRIVE_STATE = join(SCRIPTS, "drive-state.ts");
const ASSERT_POST = join(SCRIPTS, "assert-post-allowed.ts");
const MAILBOX = join(SCRIPTS, "mailbox.ts");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const roots: string[] = [];
const sleepers: Bun.Subprocess[] = [];
afterAll(() => {
  for (const p of sleepers) p.kill();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A clone directory under a fresh root of its own. */
function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "drive-db-"));
  roots.push(root);
  return scopedStateDir(root);
}

/** A process that stays alive for the test: a session the lease can judge live. */
function liveSession(): number {
  const p = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  sleepers.push(p);
  return p.pid;
}

function env(dir: string, extra: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k.startsWith("DRIVE_PR_") || v === undefined)
      continue;
    out[k] = v;
  }
  return { ...out, DRIVE_PR_STATE_DIR: dir, ...extra };
}

function run(dir: string, args: string[], extra: Record<string, string> = {}) {
  return Bun.spawnSync(scriptArgv(DRIVE_STATE, ...args), {
    env: env(dir, extra),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Everything under the state root, as relative paths. */
function tree(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
}

describe("the records registry", () => {
  it("states the drive database's version for each of its tables", () => {
    const tables = RECORD_KINDS.filter(
      (k) => k.table !== undefined && k.at.endsWith(`drive-pr/${DB_FILE}`),
    );
    expect(tables.map((k) => k.table).sort()).toEqual(
      [
        "claims",
        "counters",
        "driver_records",
        "drive_state",
        "imports",
        "leases",
        "locks",
        "review_rounds",
        "stops",
        "tree_leases",
      ].sort(),
    );
    for (const kind of tables) expect(kind.version).toBe(DRIVE_DB_VERSION);
  });
});

describe("a drive killed inside its locked section", () => {
  it("leaves the last committed round, and the next command recovers the lock at once", async () => {
    const dir = stateDir();
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_A]), 0);
    const signal = join(dirname(dir), "holding");
    const held = Bun.spawn(
      scriptArgv(DRIVE_STATE, "bump-round", "999", "--head", HEAD_B),
      {
        env: env(dir, {
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "5",
        }),
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await until(() => existsSync(signal), "the command to hold the lock");
    expect(lockNames(dir)).toContain("drive-pr-999");
    held.kill("SIGKILL");
    await held.exited;
    const started = Date.now();
    const rounds = run(dir, ["rounds", "999"]);
    expectSpawnExit(rounds, 0);
    expect(rounds.stdout.toString().trim()).toBe("1");
    const next = run(dir, ["bump-round", "999", "--head", HEAD_B], {
      DRIVE_PR_LOCK_TIMEOUT: "10",
    });
    expectSpawnExit(next, 0);
    // Recovered because its holder is dead, not after the staleness window.
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(next.stderr.toString()).toContain("broke a stale lock drive-pr-999");
    expect(readState(dir, "999")?.rounds).toBe(2);
    expect(lockNames(dir)).toEqual([]);
  });
});

describe("two drive-state.ts commands at once", () => {
  it("uses the canonical head history when prospecting a round", () => {
    const dir = stateDir();
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_A]), 0);
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_B]), 0);

    const revisited = run(dir, ["prospective-round", "999", "--head", HEAD_A]);
    expectSpawnExit(revisited, 0);
    expect(revisited.stdout.toString().trim()).toBe("2");

    const next = run(dir, [
      "prospective-round",
      "999",
      "--head",
      "c".repeat(40),
    ]);
    expectSpawnExit(next, 0);
    expect(next.stdout.toString().trim()).toBe("3");
  });

  it("reports the current round when no head is named", () => {
    const dir = stateDir();
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_A]), 0);
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_B]), 0);
    const current = run(dir, ["prospective-round", "999"]);
    expectSpawnExit(current, 0);
    expect(current.stdout.toString().trim()).toBe("2");
  });

  it("stamps a hold at the review round a hand-driven loop reached", () => {
    const dir = stateDir();
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_A]), 0);
    expectSpawnExit(run(dir, ["count-round", "999", "--head", HEAD_B]), 0);
    const hold = run(dir, [
      "hold",
      "999",
      "--key",
      "PRRT_x",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.test/c/1",
    ]);
    expectSpawnExit(hold, 0);
    const held = readState(dir, "999")?.held as { round: number }[];
    expect(held[0]?.round).toBe(2);
  });

  it("serialize on the database and leave no file behind", async () => {
    const dir = stateDir();
    const root = dirname(dir);
    const signal = join(root, "first-holds");
    const first = Bun.spawn(
      scriptArgv(DRIVE_STATE, "bump-round", "999", "--head", HEAD_A),
      {
        env: env(dir, {
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "1",
        }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await until(() => existsSync(signal), "the first command to hold the lock");
    rmSync(signal);
    const second = Bun.spawn(
      scriptArgv(DRIVE_STATE, "bump-round", "999", "--head", HEAD_B),
      { env: env(dir), stdout: "pipe", stderr: "pipe" },
    );
    const [a, b] = await Promise.all([first.exited, second.exited]);
    expect([a, b]).toEqual([0, 0]);
    expect(readState(dir, "999")?.rounds).toBe(2);
    expect(lockNames(dir)).toEqual([]);
    // The database and the files of its write-ahead log; no lock, no
    // tombstone, nothing per command.
    for (const entry of tree(root))
      expect(entry).toMatch(
        new RegExp(`^(${DB_FILE}(-wal|-shm)?|${basename(dir)}(/handoff.*)?)$`),
      );
  });
});

describe("a clone folder a release that kept files wrote", () => {
  it("is imported once at the first open: rounds, parks and leases intact, files left", () => {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const session = liveSession();
    const state = {
      ...freshState(999),
      rounds: 3,
      lastCountedHead: HEAD_A,
      parked: [
        {
          key: "PRRT_parked",
          kind: "thread",
          reason: "a person decides",
          round: 2,
        },
      ],
    };
    writeFileSync(join(dir, "drive-pr-999.json"), JSON.stringify(state));
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `pr-drive-lease-999-${ACTOR}.json`),
      JSON.stringify({
        holder: "session",
        pid: session,
        host: hostname(),
        platform: process.platform,
        actor: ACTOR,
        worktree: process.cwd(),
        startedAt: now,
        lastSeen: now,
        command: "bump-round",
        generation: "0123456789abcdef0123456789abcdef",
        sessionStarted: "",
      }),
    );
    // A tombstone of the former mutex: not read, left where it is.
    mkdirSync(
      join(dir, "drive-pr-999.json.lock.stale.owner.0123456789abcdef01234567"),
    );

    const rounds = run(dir, ["rounds", "999"]);
    expectSpawnExit(rounds, 0);
    expect(rounds.stdout.toString().trim()).toBe("3");
    const parked = run(dir, ["parked-keys", "999"]);
    expectSpawnExit(parked, 0);
    expect(parked.stdout.toString().trim()).toBe("PRRT_parked");
    const leases = run(dir, ["lease", "999", "--all"]);
    expectSpawnExit(leases, 0);
    const live = JSON.parse(leases.stdout.toString()) as {
      pid: number;
      actor: string;
      self: boolean;
    }[];
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ pid: session, actor: ACTOR, self: true });

    // The imported lease is a live session's: another session in this tree
    // is refused, as it was before the upgrade.
    const other = run(dir, ["bump-round", "999", "--head", HEAD_B], {
      DRIVE_PR_SESSION: String(liveSession()),
    });
    expectSpawnExit(other, 11);
    // Driving on as that session continues from round 3.
    expectSpawnExit(
      run(dir, ["bump-round", "999", "--head", HEAD_B], {
        DRIVE_PR_SESSION: String(session),
      }),
      0,
    );
    expect(readState(dir, "999")?.rounds).toBe(4);

    // Imported once: the files are still there, and a change to one is not
    // read again.
    expect(existsSync(join(dir, "drive-pr-999.json"))).toBe(true);
    writeFileSync(
      join(dir, "drive-pr-999.json"),
      JSON.stringify({ ...state, rounds: 9 }),
    );
    const again = run(dir, ["rounds", "999"]);
    expect(again.stdout.toString().trim()).toBe("4");
    const db = new Database(join(dirname(dir), DB_FILE), { readonly: true });
    try {
      expect(
        db
          .query("SELECT imported FROM imports WHERE clone = ?")
          .get(basename(dir)),
      ).toEqual({ imported: 2 });
    } finally {
      db.close();
    }
  });

  it("is not imported while a state file cannot be read, and the next open tries again", () => {
    const dir = stateDir();
    mkdirSync(join(dir, "drive-pr-998.json"), { recursive: true });
    const refused = run(dir, ["rounds", "999"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("drive-pr-998.json");
    const db = new Database(join(dirname(dir), DB_FILE), { readonly: true });
    try {
      expect(db.query("SELECT 1 FROM imports").get()).toBeNull();
    } finally {
      db.close();
    }
    rmSync(join(dir, "drive-pr-998.json"), { recursive: true });
    expectSpawnExit(run(dir, ["rounds", "999"]), 0);
  });

  it("calls only the names an earlier release wrote its leftovers", () => {
    expect(isFormerFile("drive-pr-999.json.lock.recovering")).toBe(true);
    expect(isFormerFile("drive-pr-remote-lock-999.lock")).toBe(true);
    expect(isFormerFile("backup.lock")).toBe(false);
    expect(isFormerFile("notes.lock.stale.mine")).toBe(false);
  });
});

describe("a database a newer copy migrated", () => {
  function migrated(dir: string, minReader: number): void {
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_A]), 0);
    const db = new Database(join(dirname(dir), DB_FILE));
    try {
      const newer = DRIVE_DB_VERSION + 1;
      db.run(
        "CREATE TABLE IF NOT EXISTS newer_things (id INTEGER PRIMARY KEY)",
      );
      db.run(`PRAGMA user_version = ${newer}`);
      db.run("UPDATE db_meta SET version = ?, min_reader = ? WHERE id = 1", [
        newer,
        minReader,
      ]);
    } finally {
      db.close();
    }
  }

  it("is read and written by this copy when the change only added", () => {
    const dir = stateDir();
    migrated(dir, DRIVE_DB_VERSION);
    expectSpawnExit(run(dir, ["bump-round", "999", "--head", HEAD_B]), 0);
    expect(readState(dir, "999")?.rounds).toBe(2);
  });

  it("is refused, naming the versions, when it needs a newer reader", () => {
    const dir = stateDir();
    migrated(dir, DRIVE_DB_VERSION + 1);
    const refused = run(dir, ["rounds", "999"]);
    expectSpawnExit(refused, 2);
    const stderr = refused.stderr.toString();
    expect(stderr).toContain(`state schema version ${DRIVE_DB_VERSION + 1}`);
    expect(stderr).toContain(`this plugin knows version ${DRIVE_DB_VERSION}`);
  });
});

describe("the lease generation", () => {
  it("rises with a takeover, and a pass whose lease was taken over is refused its post", () => {
    const dir = stateDir();
    const first = liveSession();
    expectSpawnExit(
      run(dir, ["bump-round", "999", "--head", HEAD_A], {
        DRIVE_PR_SESSION: String(first),
      }),
      0,
    );
    const before = readLease(leaseRef(dir, "999", ACTOR));
    expect(before?.pid).toBe(first);

    // The first session's lease is revoked by hand, and a second session
    // takes the drive over.
    expectSpawnExit(run(dir, ["clear-lease", "999"]), 0);
    const second = liveSession();
    expectSpawnExit(
      run(dir, ["bump-round", "999", "--head", HEAD_B], {
        DRIVE_PR_SESSION: String(second),
      }),
      0,
    );
    const after = readLease(leaseRef(dir, "999", ACTOR));
    expect(after?.pid).toBe(second);
    expect(after?.generation).toBeGreaterThan(before?.generation ?? 0);

    // The revoked pass, still alive, is refused the post.
    const post = Bun.spawnSync(scriptArgv(ASSERT_POST, "--pr", "999"), {
      env: env(dir, {
        DRIVE_PR_SESSION: String(first),
        DRIVE_PR_STATE_DIR_IDENTITY: stateIdentity(dir),
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(post, 11);
    expect(post.stderr.toString()).toContain("another live holder");
    // The session that holds it posts.
    const allowed = Bun.spawnSync(scriptArgv(ASSERT_POST, "--pr", "999"), {
      env: env(dir, {
        DRIVE_PR_SESSION: String(second),
        DRIVE_PR_STATE_DIR_IDENTITY: stateIdentity(dir),
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(allowed, 0);
  });

  it("refuses a post when the database is not the one the driver opened", () => {
    const dir = stateDir();
    writeState(dir, "999", freshState(999));
    const post = Bun.spawnSync(scriptArgv(ASSERT_POST, "--pr", "999"), {
      env: env(dir, {
        DRIVE_PR_STATE_DIR_IDENTITY: "00000000-0000-4000-8000-000000000000",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(post, 1);
    expect(post.stderr.toString()).toContain(
      "is not the one this drive opened",
    );
  });
});

/** The database's instance id, as a driver exports it. */
function stateIdentity(dir: string): string {
  const db = new Database(join(dirname(dir), DB_FILE), { readonly: true });
  try {
    return (
      db.query("SELECT instance FROM db_meta WHERE id = 1").get() as {
        instance: string;
      }
    ).instance;
  } finally {
    db.close();
  }
}

describe("the mailbox", () => {
  it("appends under a lock that leaves no file behind", () => {
    const work = mkdtempSync(join(tmpdir(), "drive-mailbox-"));
    roots.push(work);
    const box = join(work, "mailbox");
    for (const message of ["first note", "second note"]) {
      const sent = Bun.spawnSync(
        scriptArgv(
          MAILBOX,
          "send",
          "999",
          "--kind",
          "note",
          "--from",
          "probe",
          "--body",
          message,
        ),
        {
          env: { ...env(stateDir()), DRIVE_PR_MAILBOX_DIR: box },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(sent, 0);
    }
    expect(readdirSync(box)).toEqual(["inbox.jsonl"]);
  });
});
