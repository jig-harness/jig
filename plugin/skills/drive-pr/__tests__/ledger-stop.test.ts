/**
 * Marking a stopped driver's ledger from outside it (`lib/ledger-stop.ts`):
 * `drives.ts --stop` once the driver is witnessed gone, `--stop` and
 * `--doctor` against the driver record a driver marks released with its
 * locks, never against a lock left behind, each guarded so a successor's
 * ledger is left as it is. And a seed the state store refuses keeps its exit.
 */
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { formatClaim } from "../scripts/lib/claim.ts";
import {
  markDriverRecordReleased,
  writeDriverRecord,
} from "../scripts/lib/ledger-stop.ts";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import { type DriveEvent, lastStop } from "../scripts/lib/state/events.ts";
import {
  type Ledger,
  ledgerFromState,
  parseLedger,
  renderClaim,
} from "../scripts/lib/state/ledger.ts";
import { cloneId } from "../scripts/lib/state/ledger-mirror.ts";
import { leasePathFor } from "../scripts/lib/state/lease.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import {
  SCRIPTS,
  type FakeForge,
  fakeForge,
  forgeComment,
  ledgerBody,
} from "./ledger-forge-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

interface Stage {
  forge: FakeForge;
  leaf: string;
  actor: string;
  started: string;
}

/** A forge whose PR 999 carries a running ledger for `driver`. */
function stage(
  driver: Partial<Ledger["driver"]> = {},
  extra: unknown[] = [],
): Stage {
  const forge = fakeForge([], { login: "drive-bot" });
  const leaf = scopedStateDir(forge.stateDir, forge.repo);
  const actor = `wt-${worktreePathKey(forge.repo)}`;
  const started = new Date(Date.now() - 1000).toISOString();
  const ledger = ledgerFromState(
    { ...freshState(999), rounds: 2 },
    {
      generation: 3,
      driver: {
        actor,
        clone: cloneId(leaf),
        heartbeat: new Date().toISOString(),
        state: "running",
        started,
        position: 0,
        ...driver,
      },
      narrative: [],
      claims: [],
    },
  );
  writeFileSync(
    join(forge.dir, "comments.json"),
    JSON.stringify([forgeComment(40, ledgerBody(ledger)), ...extra]),
  );
  return { forge, leaf, actor, started };
}

/** PR 999's lock, claimed by `pid` driving from the forge's repository. */
function plantLock(s: Stage, pid: number): void {
  const lock = join(s.leaf, "pr-drive-999.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "claim.feedc0de"),
    formatClaim(pid, hostname(), {
      pr: "999",
      worktree: s.forge.repo,
      log: join(s.leaf, "drive-pr-999.log"),
      started: s.started,
      account: {
        account: null,
        vendor: null,
        provenance: "none",
        reason: "test",
      },
    }),
  );
}

async function drives(s: Stage, args: string[]) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drives.ts"), ...args), {
    cwd: s.forge.repo,
    env: {
      ...s.forge.env,
      DRIVE_PR_STATE_DIR: s.leaf,
      DRIVE_PR_STOP_GRACE_SEC: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function driverOf(s: Stage): Ledger["driver"] | null {
  const parsed = parseLedger(s.forge.comments()[0]?.body ?? "");
  return parsed?.kind === "ledger" ? parsed.ledger.driver : null;
}

/** A pid that is really dead: a child that ran and exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

const posixStop = skipsOnWindows(
  "process-lifecycle",
  "the stand-in driver is stopped through the POSIX process table",
);

describe("drives.ts --stop marks the stopped driver's ledger", () => {
  it.skipIf(posixStop)(
    "writes the stopped ledger once the driver is witnessed gone",
    async () => {
      const s = stage();
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      const r = await drives(s, ["--stop", "999"]);
      owner.kill("SIGKILL");
      expectSpawnExit(r, 0);
      expect(driverOf(s)).toMatchObject({ actor: s.actor, state: "stopped" });
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "leaves a ledger a successor now owns untouched, and says so",
    async () => {
      const s = stage({ actor: "wt-0123456789abcdef" });
      const before = s.forge.comments()[0]?.body;
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      const r = await drives(s, ["--stop", "999"]);
      owner.kill("SIGKILL");
      expectSpawnExit(r, 0);
      expect(r.stderr).toContain("left as it is: it names another driver");
      expect(s.forge.comments()[0]?.body).toBe(before);
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "keeps the witness when the forge refuses the write, and the next recovery consumes it",
    async () => {
      const s = stage();
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      const record = join(s.leaf, "ledger-driver-999.json");
      writeDriverRecord(s.leaf, "999", {
        worktree: s.forge.repo,
        started: s.started,
        pid: owner.pid,
        host: hostname(),
      });
      writeFileSync(join(s.forge.dir, "fail-list-after"), "0");
      const r = await drives(s, ["--stop", "999"]);
      owner.kill("SIGKILL");
      await owner.exited;
      expectSpawnExit(r, 0);
      expect(driverOf(s)?.state).toBe("running");
      expect(JSON.parse(readFileSync(record, "utf8")).released).toBe(true);
      rmSync(join(s.forge.dir, "fail-list-after"));
      // The stopped driver's abandoned lock is still in place.
      expectSpawnExit(await drives(s, ["--doctor"]), 0);
      expect(driverOf(s)).toMatchObject({ actor: s.actor, state: "stopped" });
      expect(existsSync(record)).toBe(false);
    },
    60_000,
  );
});

/** The driver record `s`'s driver leaves, `released` as it releases its locks. */
async function plantRecord(s: Stage, released: boolean): Promise<void> {
  writeFileSync(
    join(s.leaf, "ledger-driver-999.json"),
    JSON.stringify({
      worktree: s.forge.repo,
      started: s.started,
      pid: await deadPid(),
      host: hostname(),
      ...(released ? { released: true } : {}),
    }),
  );
}

describe("marking a driver record released", () => {
  it("marks only the record of the acquisition releasing its locks", () => {
    const s = stage();
    const path = join(s.leaf, "ledger-driver-999.json");
    const record = {
      worktree: s.forge.repo,
      started: s.started,
      pid: 1,
      host: "h",
    };
    writeDriverRecord(s.leaf, "999", record);
    markDriverRecordReleased(s.leaf, "999", "2000-01-01T00:00:00.000Z");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
    markDriverRecordReleased(s.leaf, "999", s.started);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...record,
      released: true,
    });
  });
});

describe("recovering the ledger of a driver that could not write it", () => {
  it("leaves it running when its driver kept its lock, its pass possibly alive", async () => {
    for (const args of [
      ["--doctor"],
      ["--doctor", "--json"],
      ["--stop", "999"],
    ]) {
      const s = stage();
      plantLock(s, await deadPid());
      await plantRecord(s, false);
      const r = await drives(s, args);
      expectSpawnExit(r, args[0] === "--stop" ? 1 : 0);
      expect(driverOf(s)?.state).toBe("running");
      expect(existsSync(join(s.leaf, "ledger-driver-999.json"))).toBe(true);
    }
  });

  it("leaves it running when its driver released no lock it was seen to release", async () => {
    const s = stage();
    await plantRecord(s, false);
    const r = await drives(s, ["--doctor"]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("did not release its locks");
    expect(driverOf(s)?.state).toBe("running");
  });

  it("leaves it when another clone's claim took the drive over since", async () => {
    const claim = renderClaim({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 3,
      at: new Date().toISOString(),
    });
    const s = stage({}, [forgeComment(80, claim, "other-bot")]);
    await plantRecord(s, true);
    const r = await drives(s, ["--doctor"]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("another clone's claim (comment 80)");
    expect(driverOf(s)?.state).toBe("running");
  });

  it("leaves it when the driver's own claim lost its generation to an earlier rival", async () => {
    const at = new Date().toISOString();
    const s = stage({ position: 9001 });
    const own = renderClaim({
      actor: s.actor,
      clone: cloneId(s.leaf),
      generation: 4,
      at,
    });
    const rival = renderClaim({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 4,
      at,
    });
    // A lagging read hid the rival from the driver, which wrote by its own claim.
    writeFileSync(
      join(s.forge.dir, "comments.json"),
      JSON.stringify([
        forgeComment(40, s.forge.comments()[0]?.body ?? ""),
        forgeComment(600, rival, "other-bot"),
        forgeComment(9001, own, "drive-bot"),
      ]),
    );
    await plantRecord(s, true);
    const r = await drives(s, ["--doctor"]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("another clone's claim (comment 600)");
    expect(driverOf(s)?.state).toBe("running");
  });

  it("marks it stopped from the driver record when its driver released its locks", async () => {
    for (const args of [
      ["--stop", "999"],
      ["--doctor"],
      ["--doctor", "--json"],
    ]) {
      const s = stage();
      await plantRecord(s, true);
      const r = await drives(s, args);
      expectSpawnExit(r, args[0] === "--stop" ? 1 : 0);
      expect(driverOf(s)).toMatchObject({ actor: s.actor, state: "stopped" });
      expect(existsSync(join(s.leaf, "ledger-driver-999.json"))).toBe(false);
    }
  });

  it("records the recovered stop locally, so an earlier run's exit never speaks for it", async () => {
    const s = stage();
    // The drive converged once, then was re-armed and stopped by a signal.
    expectSpawnExit(
      await driveState(
        s,
        ["record-event", "999"],
        '{"kind":"stop","cause":"0"}',
      ),
      0,
    );
    writeFileSync(
      join(s.leaf, "ledger-driver-999.json"),
      JSON.stringify({
        worktree: s.forge.repo,
        started: s.started,
        pid: await deadPid(),
        host: hostname(),
      }),
    );
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("stopped");
    const got = await driveState(s, ["get", "999"]);
    expectSpawnExit(got, 0);
    const events = (JSON.parse(got.stdout).events ?? []) as DriveEvent[];
    expect(lastStop(events)).toBeNull();
    expect(events.at(-1)).toMatchObject({ kind: "stop", cause: "unknown" });
  });
});

async function driveState(s: Stage, args: string[], stdin = "") {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args), {
    cwd: s.forge.repo,
    env: { ...s.forge.env, DRIVE_PR_STATE_DIR: s.leaf },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("a seed the state store refuses", () => {
  it("keeps exit 13 when another working tree holds the pull request", async () => {
    const s = stage({ clone: "clone-elsewhere", state: "stopped" });
    // Another tree's live session lease on PR 999: a plain record whose pid
    // (this test's own) is alive and whose lastSeen is fresh.
    const foreign = "wt-0000000000000dea";
    writeFileSync(
      leasePathFor(s.leaf, "999", foreign),
      JSON.stringify({
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor: foreign,
        worktree: "/some/other/tree",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "a".repeat(32),
        sessionStarted: "",
      }),
    );
    const driver = JSON.stringify(join(SCRIPTS, "lib", "driver", "ledger.ts"));
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const d = await import(${driver});
try { await d.armLedger("999", { actor: ${JSON.stringify(s.actor)}, clone: "clone-b", login: "drive-bot", started: "" }, null, null, "x"); console.log("ARMED"); }
catch (e) { console.log("EXIT " + e.code); }`,
      ],
      {
        cwd: s.forge.repo,
        env: { ...s.forge.env, DRIVE_PR_STATE_DIR: s.leaf },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(stdout).toContain("EXIT 13");
  });
});
