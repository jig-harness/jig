/**
 * drives.test.ts — the operator surface over the single-instance locks:
 * `lib/claim.ts`'s claim format + liveness rule, and `drives.ts`'s
 * listing / `--here` banner / `--stop`.
 *
 * The format tests write claim files as LITERAL bytes rather than through
 * `formatClaim`, deliberately: the wire format is the contract an older
 * driver's claims already sit on disk in, and a round-trip through the
 * serializer would keep passing if both sides drifted together.
 *
 * Every subprocess env is built from a `GIT_*`-scrubbed copy of the suite's —
 * a suite invoked from a git hook inherits `GIT_DIR`/`GIT_INDEX_FILE`, and a
 * `git init`/`rev-parse` in a temp directory then operates on the REAL
 * repository (same hazard drive-pr.test.ts documents on its own scratch
 * repos).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  gatherWorktreeLeftovers,
  listStateOnlyRows,
} from "../scripts/drives.ts";
import {
  claimLive,
  formatClaim,
  heartbeatStaleMs,
  parseClaimText,
} from "../scripts/lib/claim.ts";
import { ExitError } from "../scripts/lib/cli.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

// The listing advertises `--stop` only where `ps` can verify the pid; on
// Windows it prints "unavailable" instead.
const STOP_HINTED = !skipsOnWindows(
  "process-lifecycle",
  "--stop and its hint need `ps` to verify the driver's pid",
);

const NO_PS = skipsOnWindows(
  "process-lifecycle",
  "--stop verifies the driver's pid with `ps`, and the WEDGED verdict looks for a pass child in the process table",
);

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const DRIVES = join(SCRIPTS, "drives.ts");

const DIAG = {
  pr: "4242",
  worktree: "/elsewhere/tree",
  log: "/elsewhere/drive-pr-4242.log",
  started: "2026-08-15T00:00:00.000Z",
  account: {
    account: "dev@example.com",
    vendor: "claude" as const,
    provenance: "oauthAccount",
    reason: null,
  },
};

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  // Windows' home directory is USERPROFILE, not HOME.
  return {
    ...env,
    ...extra,
    ...(extra.HOME === undefined ? {} : { USERPROFILE: extra.HOME }),
  };
}

async function runDrives(
  args: string[],
  opts: { stateDir: string | null; cwd?: string; env?: Record<string, string> },
) {
  // `stateDir: null` models a run with NO resolvable state universe at all —
  // the env var absent, so drives.ts must fall through to its own
  // `resolveStateDir()` git query and handle that failing.
  const env = cleanEnv({
    ...(opts.stateDir === null ? {} : { DRIVE_PR_STATE_DIR: opts.stateDir }),
    ...(opts.env ?? {}),
  });
  if (opts.stateDir === null) delete env.DRIVE_PR_STATE_DIR;
  // Launched through the absolute runtime path, not the shebang, so a test
  // may cripple the child's $PATH (the ps-unavailable probe below) without
  // also breaking the launch itself.
  const proc = Bun.spawn([process.execPath, DRIVES, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env,
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

/** Plant one lock dir with the given claim entries (name → file content). */
function plantLock(
  stateDir: string,
  lockName: string,
  claims: Record<string, string>,
): string {
  const dir = join(stateDir, lockName);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(claims)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A pid that is REALLY dead: a child that ran and exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "drives-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
function freshStateDir(): string {
  const dir = join(root, `state-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("lib/claim.ts — the claim wire format", () => {
  it("round-trips pid, host and diagnostics", () => {
    const record = parseClaimText(formatClaim(123, "somehost", DIAG));
    expect(record).toEqual({ pid: 123, host: "somehost", diag: DIAG });
  });

  it("reads an older claim (pid/host only) with null diagnostics", () => {
    expect(parseClaimText("123 somehost\n")).toEqual({
      pid: 123,
      host: "somehost",
      diag: null,
    });
  });

  it('reads host-less debris as "this host", diagnostics-free', () => {
    expect(parseClaimText("123\n")).toEqual({ pid: 123, host: "", diag: null });
  });

  it("a torn or foreign second line degrades to null diagnostics, never an error", () => {
    for (const rest of [
      '{"pr": 12',
      "not json at all",
      '"a bare string"',
      '{"pr":"12"}',
      '{"pr":"x","worktree":"w","log":"l","started":"s"}',
      '{"pr":12,"worktree":"w","log":"l","started":"s"}',
      // A diag whose `account` KEY IS PRESENT but the sub-object
      // itself is malformed (`vendor` outside the closed set) — genuine
      // corruption, unlike the absent-key case below, and still degrades
      // the whole diag like any other malformed field.
      '{"pr":"12","worktree":"w","log":"l","started":"s","account":{"account":"a@b.com","vendor":"gpt","provenance":"p","reason":null}}',
      // Every field individually type-valid, but violating the RELATIONAL
      // contract `identity.ts`'s `resolved`/`unresolved` guarantee: a
      // resolved identity (`account` non-null) always carries a real
      // `vendor` and a `null` `reason`.
      '{"pr":"12","worktree":"w","log":"l","started":"s","account":{"account":"a@b.com","vendor":null,"provenance":"p","reason":"failed"}}',
      // An unresolved identity (`account` null) always carries a non-null
      // `reason` explaining the absence.
      '{"pr":"12","worktree":"w","log":"l","started":"s","account":{"account":null,"vendor":"claude","provenance":"p","reason":null}}',
      // Type-valid AND relationally consistent, but no real `resolved()`
      // call ever produces an EMPTY string for `account` or `provenance` —
      // a resolved identity with nothing actually identifying it.
      '{"pr":"12","worktree":"w","log":"l","started":"s","account":{"account":"","vendor":"claude","provenance":"","reason":null}}',
      // Same for `unresolved()`'s `reason` — never an empty explanation.
      '{"pr":"12","worktree":"w","log":"l","started":"s","account":{"account":null,"vendor":null,"provenance":"p","reason":""}}',
    ]) {
      const record = parseClaimText(`123 somehost\n${rest}\n`);
      expect(record).toEqual({ pid: 123, host: "somehost", diag: null });
    }
  });

  it("an older diag (account key entirely absent) degrades ONLY the account field, not the whole diag — an in-flight driver must stay --stop-able through the upgrade", () => {
    // Every field this shape ever had is well-formed; `account`
    // is simply a key that did not exist yet. Unlike a MALFORMED account
    // value (the previous test), this is a legitimate transitional shape —
    // an already-running driver upgraded out from under, mid-drive — and
    // degrading the whole diag here would break `drives.ts --stop` and the
    // `ownParentDriver` stand-down guard for that live process.
    const record = parseClaimText(
      '123 somehost\n{"pr":"12","worktree":"w","log":"l","started":"s"}\n',
    );
    expect(record).toEqual({
      pid: 123,
      host: "somehost",
      diag: {
        pr: "12",
        worktree: "w",
        log: "l",
        started: "s",
        account: {
          account: null,
          vendor: null,
          provenance: "claim predates account stamping",
          reason: "claim written before the billing account was stamped",
        },
      },
    });
  });

  it("a first line that names no numeric pid is no claim at all", () => {
    expect(parseClaimText("")).toBeNull();
    expect(parseClaimText("driver somehost\n")).toBeNull();
    expect(parseClaimText('\n{"pr":"1"}\n')).toBeNull();
  });

  it("a pid no real process can have — 0, or beyond safe integers — is no claim at all", () => {
    // pid 0 is the dangerous one: kill(0, sig) addresses the CALLER's whole
    // process group, so a `0 <host>` claim read as live would let --stop
    // SIGTERM the operator's own session.
    expect(parseClaimText("0 somehost\n")).toBeNull();
    expect(parseClaimText("00 somehost\n")).toBeNull();
    expect(parseClaimText("9007199254740993 somehost\n")).toBeNull();
  });

  it("claimLive: a dead pid is dead however fresh the claim", async () => {
    expect(
      claimLive({ pid: await deadPid(), host: hostname(), ageMs: 0 }),
    ).toBe(false);
  });

  it("claimLive: a live same-host pid counts only inside the staleness window", () => {
    const beyond = heartbeatStaleMs() + 1;
    expect(claimLive({ pid: process.pid, host: hostname(), ageMs: 0 })).toBe(
      true,
    );
    expect(
      claimLive({ pid: process.pid, host: hostname(), ageMs: beyond }),
    ).toBe(false);
    // An age nothing can read is not evidence of abandonment.
    expect(claimLive({ pid: process.pid, host: hostname(), ageMs: null })).toBe(
      true,
    );
  });

  it("claimLive: a foreign host is unanswerable and counts as alive", () => {
    expect(
      claimLive({
        pid: 1,
        host: "some-other-host.invalid",
        ageMs: heartbeatStaleMs() * 10,
      }),
    ).toBe(true);
  });
});

describe("drives.ts listing", () => {
  it("an empty state dir reports positively empty", async () => {
    const stateDir = freshStateDir();
    const r = await runDrives([], { stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no drive locks");
  });

  it("groups a live driver’s worktree + PR locks into one drive, with diagnostics", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), DIAG);
    plantLock(stateDir, "pr-drive-4242.lock", { "claim.aaaa": claim });
    plantLock(stateDir, "pr-drive-worktree-0123456789abcdef.lock", {
      "claim.bbbb": claim,
    });
    const r = await runDrives([], { stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("PR #4242 — LIVE");
    expect(r.stdout).toContain(DIAG.worktree);
    expect(r.stdout).toContain(DIAG.log);
    expect(r.stdout).toContain("PR #4242 + worktree");
    if (STOP_HINTED) expect(r.stdout).toContain("--stop 4242");
    // The resolved billing account, with its vendor and
    // provenance, alongside the rest of the diagnostics.
    expect(r.stdout).toContain(
      "account:  dev@example.com (claude, from oauthAccount)",
    );

    const j = await runDrives(["--json"], { stateDir });
    const parsed = JSON.parse(j.stdout) as {
      rows: Array<{
        state: string;
        kind: string;
        diag: { account: { account: string | null } } | null;
      }>;
    };
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.every((row) => row.state === "live")).toBe(true);
    expect(
      parsed.rows.every(
        (row) => row.diag?.account.account === "dev@example.com",
      ),
    ).toBe(true);
  });

  it("labels the holder `self:` when its pid is $DRIVE_PR_SESSION — the pass is looking at its own parent driver", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), DIAG);
    plantLock(stateDir, "pr-drive-4242.lock", { "claim.aaaa": claim });
    // Real drive.ts always exports both env vars together (never one without
    // the other), so a genuine "this is my own parent" test must too — a
    // diagnostics-bearing claim with no matching token in our own env is the
    // recycled-pid case, not self.
    const r = await runDrives([], {
      stateDir,
      env: {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: DIAG.started,
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("PR #4242 — LIVE");
    expect(r.stdout).toContain("self:");
    expect(r.stdout).toContain("do not stand down");
  });

  it("never labels `self:` for a different pid, an absent $DRIVE_PR_SESSION, or a foreign host", async () => {
    // One negative per clause of the guard, because a WRONG `self:` label is
    // the dangerous direction: it licenses a genuinely second driver to
    // proceed, which is the duplicate-reply corruption the census exists to
    // prevent.
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    // Different pid.
    let r = await runDrives([], {
      stateDir,
      env: { DRIVE_PR_SESSION: String(process.pid + 1) },
    });
    expect(r.stdout).toContain("PR #4242 — LIVE");
    expect(r.stdout).not.toContain("self:");
    // No $DRIVE_PR_SESSION at all (the interactive-human case). Set to the
    // empty string explicitly rather than deleted, so an ambient value from a
    // real driver above this suite cannot leak in either.
    r = await runDrives([], { stateDir, env: { DRIVE_PR_SESSION: "" } });
    expect(r.stdout).toContain("PR #4242 — LIVE");
    expect(r.stdout).not.toContain("self:");
    // Foreign host: pid equality is meaningless across machines, and a
    // foreign claim is unanswerable-but-live (see claimLive above) — exactly
    // the row a wrong label would wave through.
    const foreignDir = freshStateDir();
    plantLock(foreignDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, "some-other-host.invalid", DIAG),
    });
    r = await runDrives([], {
      stateDir: foreignDir,
      env: { DRIVE_PR_SESSION: String(process.pid) },
    });
    expect(r.stdout).toContain("PR #4242 — LIVE");
    expect(r.stdout).not.toContain("self:");
  });

  it("carries self-recognition into --json too, not only the text label", async () => {
    // The label was derived at the text print site alone, so a pass that
    // censused with `--json` — the natural machine-readable choice — got no
    // self signal at all, applied the second-driver rule to its own parent and
    // stood down. Measured on a live drive: two rounds, the pass quoting
    // `refreshAgeSec` (a --json-only field) while standing down.
    // Same predicate, so the two surfaces cannot disagree.
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    const mine = await runDrives(["--json"], {
      stateDir,
      env: {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: DIAG.started,
      },
    });
    expect(mine.exitCode).toBe(0);
    const parsed = JSON.parse(mine.stdout) as {
      rows: Array<{ key: string; self: boolean }>;
    };
    expect(parsed.rows.find((row) => row.key === "4242")?.self).toBe(true);

    // The dangerous direction, asserted on the same surface: a genuinely
    // foreign driver must never read as self, or the field licenses the
    // duplicate-reply corruption the census exists to prevent.
    const foreign = await runDrives(["--json"], {
      stateDir,
      env: { DRIVE_PR_SESSION: String(process.pid + 1) },
    });
    const foreignRows = (
      JSON.parse(foreign.stdout) as {
        rows: Array<{ key: string; self: boolean }>;
      }
    ).rows;
    expect(foreignRows.find((row) => row.key === "4242")?.self).toBe(false);
  });

  it("binds `self` to the driver ACQUISITION, not just the pid the OS may have recycled", async () => {
    // A dead driver's still-fresh claim whose pid the OS then handed to THIS
    // pass's parent reads live (same host, pid alive) and matches
    // $DRIVE_PR_SESSION — so pid+host alone would vouch for a lock the parent
    // never took. drive.ts exports its claim's own acquisition token beside
    // the pid; when the claim carries one too, they must be equal.
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    const session = { DRIVE_PR_SESSION: String(process.pid) };

    const matching = await runDrives(["--json"], {
      stateDir,
      env: { ...session, DRIVE_PR_SESSION_STARTED: DIAG.started },
    });
    expect(
      (JSON.parse(matching.stdout) as { rows: Array<{ self: boolean }> })
        .rows[0]?.self,
    ).toBe(true);

    // Same pid, same host, DIFFERENT acquisition — a recycled pid wearing a
    // dead driver's claim. This is the clause that must refuse.
    const recycled = await runDrives(["--json"], {
      stateDir,
      env: { ...session, DRIVE_PR_SESSION_STARTED: "2020-01-01T00:00:00.000Z" },
    });
    expect(
      (JSON.parse(recycled.stdout) as { rows: Array<{ self: boolean }> })
        .rows[0]?.self,
    ).toBe(false);

    // A claim with NO diagnostics cannot be bound to a token the CALLER's own
    // env supplies: `drive.ts` exports $DRIVE_PR_SESSION_STARTED only
    // alongside a claim it stamps with the same `diag.started`, so a token in
    // OUR env proves our own real parent writes diagnostics — a diagnostics-
    // free claim matching pid+host under those conditions is therefore proven
    // to be a DIFFERENT process's stale write, not our parent's, and must
    // refuse (the prior version fell back to pid+host here and would wave
    // through exactly the recycled-pid case the token exists to catch).
    const legacyDir = freshStateDir();
    plantLock(legacyDir, "pr-drive-4242.lock", {
      "claim.aaaa": `${process.pid} ${hostname()}\n`,
    });
    const legacyWithToken = await runDrives(["--json"], {
      stateDir: legacyDir,
      env: { ...session, DRIVE_PR_SESSION_STARTED: DIAG.started },
    });
    expect(
      (
        JSON.parse(legacyWithToken.stdout) as {
          rows: Array<{ self: boolean }>;
        }
      ).rows[0]?.self,
    ).toBe(false);

    // Only when the CALLER's own env carries no token at all — a
    // older driver or a hand-opted-in harness (SKILL.md § 6), neither
    // of which ever sets $DRIVE_PR_SESSION_STARTED — does pid+host stand as
    // before. Refusing here would answer false for every pass under those
    // configurations, reinstating the stand-down bug in the one direction
    // that is silent.
    const legacyNoToken = await runDrives(["--json"], {
      stateDir: legacyDir,
      env: session,
    });
    expect(
      (JSON.parse(legacyNoToken.stdout) as { rows: Array<{ self: boolean }> })
        .rows[0]?.self,
    ).toBe(true);

    // The no-token fallback is sanctioned ONLY for a genuinely diagnostics-
    // free claim — the older legacy shape a hand-opted-in harness's
    // own claim would actually be. A claim that DOES carry diagnostics can
    // never be that harness's own write (only `acquire()` stamps them,
    // always alongside the token), so one matching pid+host while OUR env
    // has no token is proof of an unrelated process — most plausibly a
    // modern claim from a dead driver whose pid got recycled — and must
    // refuse rather than trust pid+host over contradicting evidence.
    const modernDir = freshStateDir();
    plantLock(modernDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    const modernNoToken = await runDrives(["--json"], {
      stateDir: modernDir,
      env: session,
    });
    expect(
      (JSON.parse(modernNoToken.stdout) as { rows: Array<{ self: boolean }> })
        .rows[0]?.self,
    ).toBe(false);
  });

  it("withholds the --stop hint for one’s own parent driver", async () => {
    // The text listing labelled the holder `self:` — "proceed, do not stand
    // down" — and then printed a usable --stop for that same pid two lines
    // later, handing the pass a command that kills the drive it is a round of.
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    const mine = await runDrives([], {
      stateDir,
      env: {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: DIAG.started,
      },
    });
    expect(mine.stdout).toContain("self:");
    expect(mine.stdout).toContain("stop:     withheld");
    expect(mine.stdout).not.toContain("--stop 4242");

    // A foreign session is still owed the aimed command.
    const foreign = await runDrives([], {
      stateDir,
      env: { DRIVE_PR_SESSION: String(process.pid + 1) },
    });
    if (STOP_HINTED) expect(foreign.stdout).toContain("--stop 4242");
    expect(foreign.stdout).not.toContain("withheld");
  });

  it("a live older claim lists with its degradation named, and no usable stop hint", async () => {
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-77.lock", {
      "claim.cccc": `${process.pid} ${hostname()}\n`,
    });
    const r = await runDrives([], { stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("PR #77 — LIVE");
    expect(r.stdout).toContain("claim predates diagnostics");
    // --stop refuses a diag-less claim (nothing binds the pid to it), so
    // the listing must not advertise a command guaranteed to refuse.
    expect(r.stdout).not.toContain("--stop 77");
  });

  it("two diag-less legacy claims sharing a pid never merge into one driver", async () => {
    // A missing `started` is the ABSENCE of an acquisition token, not a
    // shared one: a stale legacy worktree claim and an unrelated legacy PR
    // claim with a recycled pid must list as separate entries, with no stop
    // hint for either.
    const stateDir = freshStateDir();
    const legacy = `${process.pid} ${hostname()}\n`;
    plantLock(stateDir, "pr-drive-78.lock", { "claim.aaaa": legacy });
    plantLock(stateDir, "pr-drive-worktree-fedcba9876543210.lock", {
      "claim.bbbb": legacy,
    });
    const r = await runDrives([], { stateDir });
    expect(r.exitCode).toBe(0);
    // Separate entries: the PR row does not list the worktree lock as part
    // of one drive, and no stop command is offered.
    expect(r.stdout).not.toContain("PR #78 + worktree");
    expect(r.stdout).not.toContain("--stop 78");
    expect(r.stdout).toContain("PR #78 — LIVE");
    // The host renders from the row, not from the internal grouping key —
    // whose `legacy:` prefix once displayed as the hostname.
    expect(r.stdout).toContain(`(${hostname()})`);
    expect(r.stdout).not.toContain("(legacy)");
  });

  it("a dead owner lists as stale, never as live and never dropped", async () => {
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-88.lock", {
      "claim.dddd": `${await deadPid()} ${hostname()}\n`,
    });
    const r = await runDrives(["--json"], { stateDir });
    const parsed = JSON.parse(r.stdout) as { rows: Array<{ state: string }> };
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.state).toBe("stale");
  });

  it("a live owner whose claim stopped refreshing lists as stale", async () => {
    const stateDir = freshStateDir();
    const dir = plantLock(stateDir, "pr-drive-89.lock", {
      "claim.eeee": `${process.pid} ${hostname()}\n`,
    });
    const beyond = (Date.now() - heartbeatStaleMs() - 60_000) / 1000;
    utimesSync(join(dir, "claim.eeee"), beyond, beyond);
    const r = await runDrives(["--json"], { stateDir });
    const parsed = JSON.parse(r.stdout) as { rows: Array<{ state: string }> };
    expect(parsed.rows[0]?.state).toBe("stale");
  });

  it("contested and unreadable locks are REPORTED, not silently dropped", async () => {
    // A dropped row reads as "not held" — the one thing an unreadable lock
    // never established: a scan that cannot read its input must fail closed.
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-90.lock", {
      "claim.aaaa": `${process.pid} ${hostname()}\n`,
      "claim.bbbb": `${process.pid} ${hostname()}\n`,
    });
    const unreadable = join(stateDir, "pr-drive-91.lock");
    // A claim that is a DIRECTORY defeats readFileSync the same way a
    // permission or encoding failure would.
    mkdirSync(join(unreadable, "claim.ffff"), { recursive: true });
    const r = await runDrives(["--json"], { stateDir });
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{ key: string; state: string }>;
    };
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.find((row) => row.key === "90")?.state).toBe(
      "contested",
    );
    expect(parsed.rows.find((row) => row.key === "91")?.state).toBe(
      "unreadable",
    );
    const human = await runDrives([], { stateDir });
    expect(human.stdout).toContain("NOT counting it as free");
  });

  it("a diagnostics line that disagrees with the held PR lock is called out, not trusted", async () => {
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-4242.lock", {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    plantLock(stateDir, "pr-drive-worktree-0123456789abcdef.lock", {
      "claim.bbbb": formatClaim(process.pid, hostname(), {
        ...DIAG,
        pr: "999",
      }),
    });
    const r = await runDrives([], { stateDir });
    expect(r.exitCode).toBe(0);
    if (STOP_HINTED) expect(r.stdout).toContain("--stop 4242");
    expect(r.stdout).toContain("diagnostics claim PR #999");
    expect(r.stdout).not.toContain("--stop 999");
  });

  it("two live PR locks naming one owner get no stop hint — directory order must not aim it", async () => {
    // Lock debris or a corrupt claim can leave two live PR locks with the
    // same host/pid; picking the first would decide by directory order which
    // PR receives the stop command.
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), DIAG);
    plantLock(stateDir, "pr-drive-11.lock", { "claim.aaaa": claim });
    plantLock(stateDir, "pr-drive-12.lock", { "claim.bbbb": claim });
    const r = await runDrives([], { stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ambiguous");
    expect(r.stdout).toContain("Inspect by hand");
    expect(r.stdout).not.toContain("--stop 11");
    expect(r.stdout).not.toContain("--stop 12");
  });

  it("the default (no $DRIVE_PR_STATE_DIR) listing does not mint a clone identity or create the state dir", async () => {
    // drives.ts describes its own fleet listing as read-only, but without an
    // override it used to resolve through the mutating resolveStateDir() —
    // on a clone with no persisted identity yet, merely LISTING drives
    // minted drive-pr-clone-id, created the new state directory, and could
    // write the migration marker.
    const repo = mkdtempSync(join(tmpdir(), "drives-listing-repo-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "drives-listing-home-"));
    try {
      const gitEnv = cleanEnv({});
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnv });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "drives-listing@example.invalid");
      git("config", "user.name", "drives listing probe");
      git("commit", "-q", "--allow-empty", "-m", "init", "--no-verify");

      const r = await runDrives([], {
        stateDir: null,
        cwd: repo,
        env: { HOME: fakeHome },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("no drive locks");
      expect(existsSync(join(fakeHome, ".local"))).toBe(false);
      expect(existsSync(join(repo, ".git", "drive-pr-clone-id"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("drives.ts --here (the SessionStart banner)", () => {
  let scratch: string;
  let lockName: string;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "drives-here-"));
    const init = Bun.spawn(["git", "init", "-q", scratch], {
      env: cleanEnv({}),
      stdout: "ignore",
      stderr: "pipe",
    });
    await expectSpawnExited(init, 0);
    // The lock name for the scratch tree, resolved through the SAME function
    // drive.ts calls — from a subprocess standing in that tree, because this
    // process's own derivation is memoised on the suite's cwd. Recomputing
    // the hash here would be a second derivation free to drift.
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import(${JSON.stringify(join(SCRIPTS, "lib", "state", "store.ts"))}).then(async (m) => console.log(await m.worktreeLockName()))`,
      ],
      { cwd: scratch, env: cleanEnv({}), stdout: "pipe", stderr: "pipe" },
    );
    const [out, code] = await Promise.all([
      new Response(probe.stdout).text(),
      probe.exited,
    ]);
    expect(code).toBe(0);
    lockName = out.trim();
    expect(lockName.startsWith("pr-drive-worktree-")).toBe(true);
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("prints nothing when no driver holds this worktree — silence means checked-and-clear", async () => {
    const stateDir = freshStateDir();
    const r = await runDrives(["--here"], { stateDir, cwd: scratch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("banners a live driver with PR, log and stop command — PR verified against the held per-PR lock", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), DIAG);
    plantLock(stateDir, lockName, { "claim.aaaa": claim });
    plantLock(stateDir, "pr-drive-4242.lock", { "claim.bbbb": claim });
    const r = await runDrives(["--here"], { stateDir, cwd: scratch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("LIVE drive loop is working THIS worktree");
    expect(r.stdout).toContain("driving PR #4242");
    expect(r.stdout).toContain(DIAG.log);
    if (STOP_HINTED) expect(r.stdout).toContain("--stop 4242");
  });

  it("tells a PASS the banner is its OWN parent driver, and withholds the bystander advice", async () => {
    // A pass's own SessionStart hook runs this banner, so the unqualified
    // warning is the FIRST thing that frames its parent driver as a rival —
    // before it censuses anything. Every line the normal path adds after the
    // warning ("interactive edits here will race it", the stop command) is
    // advice for a bystander and is exactly wrong for the pass this tree is
    // being driven for, so the self path must not print them.
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), DIAG);
    plantLock(stateDir, lockName, { "claim.aaaa": claim });
    plantLock(stateDir, "pr-drive-4242.lock", { "claim.bbbb": claim });
    const r = await runDrives(["--here"], {
      stateDir,
      cwd: scratch,
      env: {
        DRIVE_PR_SESSION: String(process.pid),
        DRIVE_PR_SESSION_STARTED: DIAG.started,
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("YOUR OWN parent driver");
    expect(r.stdout).toContain("proceed with the round");
    expect(r.stdout).toContain(DIAG.log);
    expect(r.stdout).not.toContain("will race it");
    expect(r.stdout).not.toContain("--stop 4242");
    // The bystander wording must be GONE, not merely accompanied: a pass that
    // reads "a LIVE drive loop is working THIS worktree" still has the premise
    // it stood down on.
    expect(r.stdout).not.toContain("LIVE drive loop is working THIS worktree");

    // Same fixture, a foreign session: the full warning is owed, stop hint and
    // all. This is the clause that keeps the self path from swallowing a real
    // second driver's banner.
    const foreign = await runDrives(["--here"], {
      stateDir,
      cwd: scratch,
      env: { DRIVE_PR_SESSION: String(process.pid + 1) },
    });
    expect(foreign.stdout).toContain(
      "LIVE drive loop is working THIS worktree",
    );
    if (STOP_HINTED) expect(foreign.stdout).toContain("--stop 4242");
    expect(foreign.stdout).not.toContain("YOUR OWN parent driver");
  });

  it("diagnostics alone may label but never aim — no matching PR lock means no stop or kill hint", async () => {
    // The stop hint must come from a held per-PR lock's NAME; the advisory
    // diagnostics line could be stale or corrupt, and an operator following it
    // would stop a different PR's driver. And no raw `kill <pid>` either: a
    // fresh claim proves liveness, not identity, so a recycled pid would send
    // the operator at a stranger, bypassing --stop's process-table check.
    const stateDir = freshStateDir();
    plantLock(stateDir, lockName, {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    const r = await runDrives(["--here"], { stateDir, cwd: scratch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("LIVE drive loop is working THIS worktree");
    expect(r.stdout).toContain("no matching live PR lock");
    expect(r.stdout).toContain("inspect the claim first");
    expect(r.stdout).not.toContain(`kill ${process.pid}`);
    expect(r.stdout).not.toContain("--stop");
  });

  it("a PR lock from a DIFFERENT acquisition never correlates — pid reuse across acquisitions gets no stop hint", async () => {
    // A driver killed between its two lock writes leaves a live worktree
    // claim; its pid recycled onto another driver must not correlate with
    // that driver's PR lock just because host/pid match. `diag.started` is
    // the per-acquisition token: one acquisition writes one diag to both
    // locks.
    const stateDir = freshStateDir();
    plantLock(stateDir, lockName, {
      "claim.aaaa": formatClaim(process.pid, hostname(), DIAG),
    });
    plantLock(stateDir, "pr-drive-4242.lock", {
      "claim.bbbb": formatClaim(process.pid, hostname(), {
        ...DIAG,
        started: "2026-08-15T11:11:11.111Z",
      }),
    });
    const r = await runDrives(["--here"], { stateDir, cwd: scratch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("LIVE drive loop is working THIS worktree");
    expect(r.stdout).toContain("no matching live PR lock");
    expect(r.stdout).not.toContain("--stop");
    expect(r.stdout).not.toContain(`kill ${process.pid}`);
  });

  it("two live PR locks naming this driver are ambiguous — labelled, with no stop or kill hint", async () => {
    // Directory order must not decide which PR the stop command targets
    // when lock debris or a corrupt claim leaves two live PR locks naming
    // the same owner.
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), DIAG);
    plantLock(stateDir, lockName, { "claim.aaaa": claim });
    plantLock(stateDir, "pr-drive-4242.lock", { "claim.bbbb": claim });
    plantLock(stateDir, "pr-drive-4243.lock", { "claim.cccc": claim });
    const r = await runDrives(["--here"], { stateDir, cwd: scratch });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("LIVE drive loop is working THIS worktree");
    expect(r.stdout).toContain("ambiguous");
    expect(r.stdout).not.toContain("--stop");
    expect(r.stdout).not.toContain(`kill ${process.pid}`);
  });

  it("a stale lock prints nothing; an unreadable one prints a warning, never silence", async () => {
    const staleState = freshStateDir();
    const dir = plantLock(staleState, lockName, {
      "claim.aaaa": `${await deadPid()} ${hostname()}\n`,
    });
    const stale = await runDrives(["--here"], {
      stateDir: staleState,
      cwd: scratch,
    });
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toBe("");
    rmSync(dir, { recursive: true, force: true });

    const brokenState = freshStateDir();
    mkdirSync(join(brokenState, lockName, "claim.gggg"), { recursive: true });
    const broken = await runDrives(["--here"], {
      stateDir: brokenState,
      cwd: scratch,
    });
    expect(broken.exitCode).toBe(0);
    expect(broken.stdout).toContain("could not determine");
  });

  it("outside a git repository it warns rather than pretending to have checked", async () => {
    const stateDir = freshStateDir();
    const nowhere = mkdtempSync(join(tmpdir(), "drives-norepo-"));
    try {
      const r = await runDrives(["--here"], { stateDir, cwd: nowhere });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("cannot check");
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });

  it("a failing state-dir resolution warns on STDOUT, never silently — the hook discards stderr", async () => {
    // With no $DRIVE_PR_STATE_DIR and no git repository, `resolveStateDir()`
    // itself fails — on stderr, with a thrown exit. The SessionStart hook
    // discards stderr, so unless --here converts that failure into a stdout
    // warning, a broken check is indistinguishable from "checked, and clear".
    const nowhere = mkdtempSync(join(tmpdir(), "drives-nostate-"));
    try {
      const r = await runDrives(["--here"], { stateDir: null, cwd: nowhere });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("cannot check");
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });

  it("does not mint a clone identity or create the state dir — this runs on EVERY session open", async () => {
    // Without $DRIVE_PR_STATE_DIR, --here used to resolve through the
    // mutating resolveStateDir(): on a clone with no persisted identity
    // yet, merely opening an otherwise-unused repository minted
    // drive-pr-clone-id, created the new state directory, and could write
    // the migration marker — real, permanent side effects from a banner
    // check that fires on every SessionStart, never told to.
    const fakeHome = mkdtempSync(join(tmpdir(), "drives-here-home-"));
    try {
      const r = await runDrives(["--here"], {
        stateDir: null,
        cwd: scratch,
        env: { HOME: fakeHome },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
      expect(existsSync(join(fakeHome, ".local"))).toBe(false);
      expect(existsSync(join(scratch, ".git", "drive-pr-clone-id"))).toBe(
        false,
      );
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("drives.ts --stop", () => {
  /** A long-lived child whose process-table command names drive.ts. */
  function markerDriver() {
    return Bun.spawn(
      [
        process.execPath,
        "-e",
        "await new Promise((r) => setTimeout(r, 300000))",
        "drive.ts",
        "555",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  }

  function aliveNow(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it.skipIf(NO_PS)(
    "SIGTERMs the live driver and witnesses it leave",
    async () => {
      const stateDir = freshStateDir();
      const child = markerDriver();
      try {
        // `started` is stamped AFTER spawning the child, as in reality: the
        // driver process starts, then acquires and writes its claim. The claim
        // binding in stop() compares exactly these two instants.
        plantLock(stateDir, "pr-drive-555.lock", {
          "claim.aaaa": formatClaim(child.pid, hostname(), {
            ...DIAG,
            pr: "555",
            started: new Date().toISOString(),
          }),
        });
        const r = await runDrives(["--stop", "555"], { stateDir });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(`sent SIGTERM to driver pid ${child.pid}`);
        expect(r.stdout).toContain("stopped");
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  it.skipIf(NO_PS)(
    "refuses a live drive.ts process that started after the claim was written — argv alone never authorizes",
    async () => {
      // The recycled-pid case DRIVER_CMD cannot catch: the pid now runs a
      // GENUINE driver (of some other PR), so its argv passes. The claim
      // binding refuses it — a process that started after the claim's
      // acquisition timestamp cannot be the process that wrote the claim.
      const stateDir = freshStateDir();
      const child = markerDriver();
      try {
        plantLock(stateDir, "pr-drive-552.lock", {
          "claim.aaaa": formatClaim(child.pid, hostname(), {
            ...DIAG,
            pr: "552",
            started: new Date(Date.now() - 3_600_000).toISOString(),
          }),
        });
        const r = await runDrives(["--stop", "552"], { stateDir });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("started after the claim");
        expect(aliveNow(child.pid)).toBe(true);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  it.skipIf(NO_PS)(
    "refuses a claim whose acquisition time is in the future — a future bound accepts every process",
    async () => {
      // `procStart > future + slack` is false for ANY process, so a recycled
      // pid wearing a clock-skewed or corrupt claim would pass the binding.
      // Fixture passes every other
      // clause — driver argv, local host, live pid, readable etime — so the
      // future timestamp is the sole decider.
      const stateDir = freshStateDir();
      const child = markerDriver();
      try {
        plantLock(stateDir, "pr-drive-549.lock", {
          "claim.aaaa": formatClaim(child.pid, hostname(), {
            ...DIAG,
            pr: "549",
            started: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        });
        const r = await runDrives(["--stop", "549"], { stateDir });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("in the future");
        expect(aliveNow(child.pid)).toBe(true);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  it.skipIf(NO_PS)(
    "refuses a live claim with no diagnostics line — nothing binds the pid to the claim",
    async () => {
      // Fail-closed-conjunction fixture: the child's argv passes DRIVER_CMD,
      // the host is local, the pid is alive and the claim is fresh — the
      // ABSENT diagnostics line is the sole decider. An older claim
      // has no acquisition timestamp, so the pid cannot be bound to it and
      // must not be signaled.
      const stateDir = freshStateDir();
      const child = markerDriver();
      try {
        plantLock(stateDir, "pr-drive-551.lock", {
          "claim.aaaa": `${child.pid} ${hostname()}\n`,
        });
        const r = await runDrives(["--stop", "551"], { stateDir });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("no diagnostics line");
        expect(aliveNow(child.pid)).toBe(true);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  it.skipIf(NO_PS)(
    "refuses to signal a live pid whose command is not a drive.ts driver (recycled pid)",
    async () => {
      // A crashed driver's pid can be recycled to a stranger inside the
      // staleness window; the claim then reads live but the pid is not the
      // driver. The stranger must survive the --stop.
      const stateDir = freshStateDir();
      const child = Bun.spawn(["sleep", "300"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        plantLock(stateDir, "pr-drive-554.lock", {
          "claim.aaaa": formatClaim(child.pid, hostname(), {
            ...DIAG,
            pr: "554",
          }),
        });
        const r = await runDrives(["--stop", "554"], { stateDir });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("does not look like a drive.ts driver");
        expect(aliveNow(child.pid)).toBe(true);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  it("fails closed when ps cannot answer for a live pid — refuses, never signals on the claim alone", async () => {
    // `ps` missing (the documented Windows path) or failing transiently must
    // not fall through to SIGTERM: claim freshness proves liveness, not
    // identity, so a recycled pid would be signaled exactly when verification
    // fails. The stranger must survive, and the refusal must say why.
    const stateDir = freshStateDir();
    const child = Bun.spawn(["sleep", "300"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const empty = mkdtempSync(join(tmpdir(), "drives-nops-"));
    try {
      plantLock(stateDir, "pr-drive-553.lock", {
        "claim.aaaa": formatClaim(child.pid, hostname(), {
          ...DIAG,
          pr: "553",
        }),
      });
      const r = await runDrives(["--stop", "553"], {
        stateDir,
        env: { PATH: empty },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("refusing to signal");
      expect(r.stdout).toContain("could not verify");
      expect(aliveNow(child.pid)).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      child.kill();
      await child.exited;
    }
  });

  it("bounds a HUNG ps with a deadline — refuses fail-closed instead of blocking --stop forever", async () => {
    // An OS/process-table problem can make `ps` hang rather than fail; the
    // probe must carry its own deadline so --stop still terminates, landing in
    // the same "could not verify" refusal. Without the deadline this test
    // itself hangs past bun's per-test timeout.
    const stateDir = freshStateDir();
    const child = Bun.spawn(["sleep", "300"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const shim = mkdtempSync(join(tmpdir(), "drives-hungps-"));
    try {
      // Absolute path in the shim: its own $PATH is the crippled one, so a
      // bare `sleep` would fail instantly and the fixture would exercise the
      // ps-FAILED branch instead of the ps-HUNG one.
      writeFakeProgram(join(shim, "ps"), "#!/bin/sh\nexec /bin/sleep 300\n");
      plantLock(stateDir, "pr-drive-550.lock", {
        "claim.aaaa": formatClaim(child.pid, hostname(), {
          ...DIAG,
          pr: "550",
          started: new Date().toISOString(),
        }),
      });
      const r = await runDrives(["--stop", "550"], {
        stateDir,
        // A 1s deadline on the hung `ps` instead of the production 10s.
        env: { PATH: shim, DRIVE_PR_STOP_PS_TIMEOUT_SEC: "1" },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("could not verify");
      expect(aliveNow(child.pid)).toBe(true);
    } finally {
      rmSync(shim, { recursive: true, force: true });
      child.kill();
      await child.exited;
    }
  }, 25_000);

  it("finds nothing to stop on an absent or stale lock", async () => {
    const stateDir = freshStateDir();
    const absent = await runDrives(["--stop", "556"], { stateDir });
    expect(absent.exitCode).toBe(1);
    expect(absent.stdout).toContain("nothing to stop");

    plantLock(stateDir, "pr-drive-557.lock", {
      "claim.aaaa": `${await deadPid()} ${hostname()}\n`,
    });
    const stale = await runDrives(["--stop", "557"], { stateDir });
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout).toContain("stale");
  });

  it("refuses a foreign-host driver and an unreadable claim", async () => {
    const stateDir = freshStateDir();
    plantLock(stateDir, "pr-drive-558.lock", {
      "claim.aaaa": `1 some-other-host.invalid\n`,
    });
    const foreign = await runDrives(["--stop", "558"], { stateDir });
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stdout).toContain("some-other-host.invalid");

    mkdirSync(join(stateDir, "pr-drive-559.lock", "claim.bbbb"), {
      recursive: true,
    });
    const broken = await runDrives(["--stop", "559"], { stateDir });
    expect(broken.exitCode).toBe(1);
    expect(broken.stdout).toContain("refusing to guess");
  });

  it.skipIf(NO_PS)(
    "falls back to the legacy directory when resolveStateDir() refuses on the very lock --stop needs to reach",
    async () => {
      // The deadlock this closes: an older driver's own single-instance
      // lock, still sitting in the legacy `--git-common-dir`, is EXACTLY the
      // unmigrated footprint `ensureMigratedFromLegacy` refuses on — so
      // `resolveStateDir()` (which `--stop` called first, before this fix)
      // throws before `stop()` ever runs, leaving no way to reach the very
      // driver `--stop` exists to reach. No `DRIVE_PR_STATE_DIR` override here
      // — that would bypass `resolveStateDir()` entirely and prove nothing
      // about the fallback.
      const repo = mkdtempSync(join(tmpdir(), "drives-stop-legacy-repo-"));
      const home = mkdtempSync(join(tmpdir(), "drives-stop-legacy-home-"));
      const gitEnv = cleanEnv({ HOME: home });
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnv });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "drives-stop-probe@example.invalid");
      git("config", "user.name", "drives --stop probe");
      const legacyDir = join(repo, ".git");
      const child = markerDriver();
      try {
        // This lock IS the unmigrated footprint: `legacyFootprint` recognizes
        // `pr-drive-<n>.lock` on sight, so `ensureMigratedFromLegacy` refuses
        // the plain `resolveStateDir()` path on the very driver this test then
        // asks `--stop` to reach.
        plantLock(legacyDir, "pr-drive-555.lock", {
          "claim.aaaa": formatClaim(child.pid, hostname(), {
            ...DIAG,
            pr: "555",
            started: new Date().toISOString(),
          }),
        });
        const r = await runDrives(["--stop", "555"], {
          stateDir: null,
          cwd: repo,
          env: { HOME: home },
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain(`sent SIGTERM to driver pid ${child.pid}`);
        expect(r.stdout).toContain("stopped");
      } finally {
        child.kill();
        await child.exited;
        rmSync(repo, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("does NOT fall back to the legacy directory on a resolveStateDir() failure that is not the migration guard", async () => {
    // An over-broad version of the fallback caught ANY resolveStateDir()
    // failure, including one with nothing to do with a live older
    // driver — a malformed $DRIVE_PR_STATE_DIR, here — and silently fell back
    // to the legacy directory anyway, masking the real problem behind a
    // harmless-looking "nothing to stop" instead of surfacing it. legacyDir
    // is genuinely empty (no drive-pr footprint at all), which is exactly
    // the signal the narrowed catch uses to tell the two failure classes
    // apart.
    const repo = mkdtempSync(join(tmpdir(), "drives-stop-non-migration-repo-"));
    const home = mkdtempSync(join(tmpdir(), "drives-stop-non-migration-home-"));
    const gitEnv = cleanEnv({ HOME: home });
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnv });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "drives-stop-probe@example.invalid");
    git("config", "user.name", "drives --stop probe");
    try {
      // `stateDir` (not `null`): `runDrives` deletes `DRIVE_PR_STATE_DIR`
      // unconditionally when `stateDir` is `null`, even if `env` also names
      // it — passing the relative value AS `stateDir` is what actually gets
      // it onto the child's environment here.
      const r = await runDrives(["--stop", "556"], {
        stateDir: "relative/not-absolute",
        cwd: repo,
        env: { HOME: home },
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("must be an absolute path");
      // Not the fallback's own "nothing to stop" wording — the original
      // failure must be what the caller sees.
      expect(r.stdout).not.toContain("nothing to stop");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("drives.ts usage", () => {
  it("rejects unknown flags, a non-numeric --stop, and mixed modes", async () => {
    const stateDir = freshStateDir();
    expect((await runDrives(["--nope"], { stateDir })).exitCode).toBe(2);
    expect((await runDrives(["--stop", "x"], { stateDir })).exitCode).toBe(2);
    expect((await runDrives(["--here", "--json"], { stateDir })).exitCode).toBe(
      2,
    );
  });

  it("--doctor is mutually exclusive with --here/--stop but combines with --json", async () => {
    const stateDir = freshStateDir();
    expect(
      (await runDrives(["--doctor", "--here"], { stateDir })).exitCode,
    ).toBe(2);
    expect(
      (await runDrives(["--doctor", "--stop", "1"], { stateDir })).exitCode,
    ).toBe(2);
    // Combines with --json: not a usage error, whatever it reports about an
    // empty fleet.
    expect(
      (await runDrives(["--doctor", "--json"], { stateDir })).exitCode,
    ).toBe(0);
  });
});

// `drives.ts --json` (with or without `--doctor`) carries a `doctor` verdict on
// every PR-kind row. Seeded with `parked: [...]` rather than a live claim's own
// progress/pass-child machinery, deliberately: a parked item forces
// `classifyDrive`'s `NEEDS_HUMAN` branch (rule 4), unconditional on lock state,
// so this test's outcome does not depend on whether the sandbox running it
// happens to have a working `ps` or a real worktree at `DIAG.worktree` — both
// of which `NEEDS_HUMAN` outranks entirely (see `lib/doctor.ts`'s own
// precedence-order header).
describe("drives.ts --json carries the doctor verdict", () => {
  function seedParkedState(stateDir: string, pr: string): void {
    const state = {
      ...freshState(Number.parseInt(pr, 10)),
      parked: [
        { key: "PRRT_x", kind: "thread", reason: "needs a human", round: 1 },
      ],
    };
    writeFileSync(join(stateDir, `drive-pr-${pr}.json`), JSON.stringify(state));
  }

  it("plain --json includes doctor.verdict = NEEDS_HUMAN for a row with a parked item", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), { ...DIAG, pr: "7001" });
    plantLock(stateDir, "pr-drive-7001.lock", { "claim.aaaa": claim });
    seedParkedState(stateDir, "7001");

    const r = await runDrives(["--json"], { stateDir });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{
        kind: string;
        key: string;
        doctor: {
          verdict: string;
          reason: string;
          recovery: string | null;
        } | null;
      }>;
    };
    const row = parsed.rows.find((x) => x.kind === "pr" && x.key === "7001");
    expect(row?.doctor?.verdict).toBe("NEEDS_HUMAN");
    expect(row?.doctor?.reason).toContain("1 item");
  });

  it("a worktree-kind row carries doctor: null — classification is per-PR only", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), { ...DIAG, pr: "7002" });
    plantLock(stateDir, "pr-drive-worktree-0123456789abcdef.lock", {
      "claim.aaaa": claim,
    });
    const r = await runDrives(["--json"], { stateDir });
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{ kind: string; doctor: unknown }>;
    };
    const row = parsed.rows.find((x) => x.kind === "worktree");
    expect(row?.doctor).toBeNull();
  });

  it("--doctor human output prints the verdict and reason per PR row", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), { ...DIAG, pr: "7003" });
    plantLock(stateDir, "pr-drive-7003.lock", { "claim.aaaa": claim });
    seedParkedState(stateDir, "7003");

    const r = await runDrives(["--doctor"], { stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("PR #7003");
    expect(r.stdout).toContain("NEEDS_HUMAN");
  });

  it("a row with no state file at all reports UNKNOWN, never a crash or a silent drop", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), { ...DIAG, pr: "7004" });
    plantLock(stateDir, "pr-drive-7004.lock", { "claim.aaaa": claim });
    // Deliberately NO drive-pr-7004.json written.
    const r = await runDrives(["--json"], { stateDir });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{ key: string; doctor: { verdict: string } | null }>;
    };
    expect(parsed.rows.find((x) => x.key === "7004")?.doctor?.verdict).toBe(
      "UNKNOWN",
    );
  });
});

// `process.pid` (the test runner's own) is safe to use as the fabricated driver
// pid here. A `ps` this file spawns could otherwise show up as a live,
// non-excluded descendant of itself, but `findPassChild` prunes excluded
// helpers and never descends into their children at all: `drives.ts` itself
// (the subprocess `runDrives` spawns) is a DIRECT child of `process.pid` and
// matches `OWN_HELPER_SCRIPT`, so it is excluded and PRUNED before its own `ps`
// grandchild is ever reached. The walk therefore correctly reports `false`
// unless something else already parented directly under this test process
// happens to be alive at the same instant.
describe('an empty-string diag.worktree is treated as null, never as "this process\'s own cwd"', () => {
  it('a dead driver whose claim recorded worktree: "" reports the SAME "no worktree to inspect" answer as a missing worktree, not a real (and wrong) inspection', async () => {
    // `drive.ts` writes `worktree: ''` when `git rev-parse --show-toplevel`
    // itself failed at acquisition time — a LEGAL `ClaimDiag` shape
    // (`claim.ts` only checks `typeof === 'string'`). `git -C '' …` silently
    // resolves to THIS PROCESS's own cwd, not "no worktree" — without the
    // fix, this fixture's verdict would depend on whatever uncommitted state
    // the repository running this suite happens to be in, which is exactly
    // the non-determinism (and misattribution — a stranger's dirty tree
    // reported as THIS drive's leftovers) the fix exists to close.
    const stateDir = freshStateDir();
    const pid = await deadPid();
    const claim = formatClaim(pid, hostname(), {
      ...DIAG,
      pr: "7041",
      worktree: "",
    });
    plantLock(stateDir, "pr-drive-7041.lock", { "claim.aaaa": claim });
    writeFileSync(
      join(stateDir, "drive-pr-7041.json"),
      JSON.stringify(freshState(7041)),
    );
    const r = await runDrives(["--json"], { stateDir });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{
        key: string;
        doctor: { verdict: string; reason: string } | null;
      }>;
    };
    const row = parsed.rows.find((x) => x.key === "7041");
    expect(row?.doctor?.verdict).toBe("UNKNOWN");
    expect(row?.doctor?.reason).toContain("records no worktree to inspect");
  });
});

describe("a future-dated lastProgressAt is treated as unknown, not as freshest-possible", () => {
  it("a live row whose lastProgressAt is in the future does not read as HEALTHY on that basis alone", async () => {
    // `Date.now() - Date.parse(lastProgressAt)` goes NEGATIVE for a
    // future-dated stamp (clock skew between machines, or a corrupted/
    // hand-edited state file) — `!stale` for a negative age, so a bare
    // `passChild === false` claim (no pass, this host) would otherwise
    // still classify HEALTHY purely because the age looks impossibly fresh.
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), { ...DIAG, pr: "7042" });
    plantLock(stateDir, "pr-drive-7042.lock", { "claim.aaaa": claim });
    const oneHourFromNow = new Date(Date.now() + 60 * 60_000).toISOString();
    writeFileSync(
      join(stateDir, "drive-pr-7042.json"),
      JSON.stringify({ ...freshState(7042), lastProgressAt: oneHourFromNow }),
    );
    const r = await runDrives(["--json"], { stateDir });
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{ key: string; doctor: { verdict: string } | null }>;
    };
    const row = parsed.rows.find((x) => x.key === "7042");
    // Treated as `progressAgeMs: null` (same as never-stamped) — UNKNOWN,
    // not HEALTHY, and not WEDGED either (WEDGED also requires a KNOWN
    // stale age).
    expect(row?.doctor?.verdict).toBe("UNKNOWN");
  });
});

describe("a foreign-host claim never walks the LOCAL process table", () => {
  it("a foreign-host live claim with stale progress reports UNKNOWN, never WEDGED (the local pid coincidence must not leak through)", async () => {
    // `claimLive` treats every foreign host as unanswerable-and-alive
    // (`pidAlive`'s own foreign-host branch), so this claim reads `live`
    // regardless of whether `process.pid` — used here BECAUSE it is a real,
    // resolvable pid on THIS machine, not because it means anything for a
    // claim naming a different host — happens to have direct children of
    // its own at the instant of the probe. Without the M2 host gate,
    // `findPassChild` would walk `process.pid` against the LOCAL `ps` table
    // anyway (a coincidental pid-number match), most likely finding nothing
    // non-excluded and reporting `passChild: false` — combined with stale
    // progress, a false `WEDGED` for a drive that is not even ON this host.
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, "some-other-host.example.invalid", {
      ...DIAG,
      pr: "7040",
    });
    plantLock(stateDir, "pr-drive-7040.lock", { "claim.aaaa": claim });
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    writeFileSync(
      join(stateDir, "drive-pr-7040.json"),
      JSON.stringify({ ...freshState(7040), lastProgressAt: fourHoursAgo }),
    );
    const r = await runDrives(["--json"], { stateDir });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      rows: Array<{ key: string; doctor: { verdict: string } | null }>;
    };
    const row = parsed.rows.find((x) => x.key === "7040");
    expect(row?.doctor?.verdict).not.toBe("WEDGED");
  });
});

describe("--doctor / --json WEDGED end-to-end", () => {
  it.skipIf(NO_PS)(
    "a live claim with stale progress and no pass child classifies WEDGED, with a working --stop recovery",
    async () => {
      const stateDir = freshStateDir();
      const claim = formatClaim(process.pid, hostname(), {
        ...DIAG,
        pr: "7010",
      });
      plantLock(stateDir, "pr-drive-7010.lock", { "claim.aaaa": claim });
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
      writeFileSync(
        join(stateDir, "drive-pr-7010.json"),
        JSON.stringify({ ...freshState(7010), lastProgressAt: fourHoursAgo }),
      );

      // Plain --json, not --doctor --json: WEDGED must be reachable through
      // the SAME classification pass the plain listing already runs
      // unconditionally, not only through the doctor-specific surfaces.
      const r = await runDrives(["--json"], { stateDir });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        rows: Array<{
          key: string;
          doctor: { verdict: string; recovery: string | null } | null;
        }>;
      };
      const row = parsed.rows.find((x) => x.key === "7010");
      expect(row?.doctor?.verdict).toBe("WEDGED");
      expect(row?.doctor?.recovery).toContain("--stop 7010");
    },
  );

  it.skipIf(NO_PS)(
    "the PLAIN human listing (no --doctor) prints the stalled line on a WEDGED live row",
    async () => {
      // `printHuman`'s own `⚠ stalled:` line: both this and the --json case
      // above must read off the SAME `.doctor` field `attachDoctorVerdicts`
      // populates unconditionally.
      const stateDir = freshStateDir();
      const claim = formatClaim(process.pid, hostname(), {
        ...DIAG,
        pr: "7011",
      });
      plantLock(stateDir, "pr-drive-7011.lock", { "claim.aaaa": claim });
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
      writeFileSync(
        join(stateDir, "drive-pr-7011.json"),
        JSON.stringify({ ...freshState(7011), lastProgressAt: fourHoursAgo }),
      );
      const r = await runDrives([], { stateDir });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("PR #7011 — LIVE");
      expect(r.stdout).toContain("⚠ stalled:");
      expect(r.stdout).toContain("no pass process is running");
    },
  );
});

describe("printHuman surfaces DEAD_WITH_LEFTOVERS on a stale row", () => {
  it('a dead driver whose worktree still has an unconcluded merge prints the leftovers reason and recovery, not just "the next drive recovers it"', async () => {
    // A resolvable upstream is REQUIRED, not incidental to this fixture:
    // `gatherWorktreeLeftovers` fails the WHOLE record to `null` if ANY of
    // its three probes cannot complete (documented, deliberate — see that
    // function's own header), including the upstream check, EVEN THOUGH the
    // MERGE_HEAD marker was already found by an earlier probe. A repo with
    // no remote configured at all reddens this test for the wrong reason
    // (an unrelated fail-closed null, not this M6 fix) — found while first
    // writing this fixture without one.
    const stateDir = freshStateDir();
    const repo = mkdtempSync(join(tmpdir(), "m6-repo-"));
    const home = mkdtempSync(join(tmpdir(), "m6-home-"));
    const env = cleanEnv({ HOME: home });
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo, env });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "m6-probe@example.invalid");
    git("config", "user.name", "m6 probe");
    writeFileSync(join(repo, "README.md"), "seed\n");
    git("add", ".");
    git("commit", "-q", "-m", "seed");
    const bareDir = mkdtempSync(join(tmpdir(), "m6-origin-"));
    Bun.spawnSync(["git", "init", "-q", "--bare", bareDir], { env });
    git("remote", "add", "origin", bareDir);
    git("push", "-q", "-u", "origin", "main");
    // Planting the marker file directly is sufficient — the probe only
    // checks for its PRESENCE (`unconcludedGitOpMarker`), no real conflict
    // needed, matching `gatherWorktreeLeftovers`'s own test fixtures above.
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${"a".repeat(40)}\n`);
    try {
      const pid = await deadPid();
      const claim = formatClaim(pid, hostname(), {
        ...DIAG,
        pr: "7030",
        worktree: repo,
      });
      plantLock(stateDir, "pr-drive-7030.lock", { "claim.aaaa": claim });
      // Without a state file, `stateReadable: false` trips `classifyDrive`'s
      // OWN fail-closed rule 1 before rule 2 (the leftovers check) is ever
      // reached, reading UNKNOWN instead — a real gap in this fixture, found
      // while first writing it, not a finding about the implementation.
      writeFileSync(
        join(stateDir, "drive-pr-7030.json"),
        JSON.stringify(freshState(7030)),
      );
      const r = await runDrives([], { stateDir });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("stale");
      expect(r.stdout).toContain("MERGE_HEAD");
      expect(r.stdout).toContain("recovery:");
      expect(r.stdout).toContain("status --short");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe("--doctor sweeps state files with no surviving lock", () => {
  it("a quota-parked drive whose lock directory is already gone (as drive.ts leaves it on exit) still reports QUOTA_PARKED under --doctor", async () => {
    const stateDir = freshStateDir();
    // Deliberately NO pr-drive-7020.lock at all — `drive.ts`'s `release()`
    // `rmdir`s it on every normal exit, including the quota-park one, so a
    // real parked drive leaves exactly this on disk: a state file, no lock.
    writeFileSync(
      join(stateDir, "drive-pr-7020.json"),
      JSON.stringify({
        ...freshState(7020),
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: null,
          at: new Date().toISOString(),
        },
      }),
    );

    const plain = await runDrives(["--json"], { stateDir });
    const plainParsed = JSON.parse(plain.stdout) as {
      rows: Array<{ key: string }>;
    };
    // Plain --json stays LOCK ROWS ONLY (deliberate — see
    // `listStateOnlyRows`'s own header): this row has no lock, so it must
    // not appear here at all.
    expect(plainParsed.rows.find((r) => r.key === "7020")).toBeUndefined();

    const doctor = await runDrives(["--doctor", "--json"], { stateDir });
    expect(doctor.exitCode).toBe(0);
    const doctorParsed = JSON.parse(doctor.stdout) as {
      rows: Array<{
        key: string;
        state: string;
        doctor: { verdict: string } | null;
      }>;
    };
    const row = doctorParsed.rows.find((r) => r.key === "7020");
    expect(row?.state).toBe("empty");
    expect(row?.doctor?.verdict).toBe("QUOTA_PARKED");

    const human = await runDrives(["--doctor"], { stateDir });
    expect(human.stdout).toContain("PR #7020");
    expect(human.stdout).toContain("QUOTA_PARKED");
  });

  it("a state-only row for a PR that ALSO has a real lock is not duplicated", async () => {
    const stateDir = freshStateDir();
    const claim = formatClaim(process.pid, hostname(), { ...DIAG, pr: "7021" });
    plantLock(stateDir, "pr-drive-7021.lock", { "claim.aaaa": claim });
    writeFileSync(
      join(stateDir, "drive-pr-7021.json"),
      JSON.stringify(freshState(7021)),
    );
    const doctor = await runDrives(["--doctor", "--json"], { stateDir });
    const parsed = JSON.parse(doctor.stdout) as {
      rows: Array<{ key: string; kind: string }>;
    };
    expect(
      parsed.rows.filter((r) => r.key === "7021" && r.kind === "pr"),
    ).toHaveLength(1);
  });

  it("a READABLE lock-less state file with no park and nothing parked earns no row — the sweep is not padded with dead PRs", () => {
    // Measured on one ordinary clone before this guard: 237 `drive-pr-*.json`
    // files, so `--doctor` printed 238 rows, every one UNKNOWN. The files
    // accumulate per PR ever driven and are bounded only by `reap-state.ts`'s
    // weekly pass, so this is steady-state, not a transient. A sweep that
    // buries its findings under two hundred lines of "insufficient evidence"
    // is one nobody reads.
    const stateDir = freshStateDir();
    writeFileSync(
      join(stateDir, "drive-pr-7030.json"),
      JSON.stringify(freshState(7030)),
    );
    expect(listStateOnlyRows(stateDir, [])).toEqual([]);
  });

  it("an UNREADABLE lock-less state file DOES earn a row — the skip above is not a fail-open", () => {
    // The distinction the guard turns on, asserted as its own case so the two
    // cannot regress into one: the fail-closed rule for scans is about input
    // the gate cannot READ, and this file cannot be read. A state dir full of
    // these is exactly the "your state files predate this version" signal an
    // operator needs, and it must survive the noise filter that drops the
    // readable-and-inert ones.
    const stateDir = freshStateDir();
    writeFileSync(join(stateDir, "drive-pr-7031.json"), "{ not json");
    const rows = listStateOnlyRows(stateDir, []);
    expect(rows.map((r) => r.key)).toEqual(["7031"]);
  });

  it("a lock-less state file with a PARKED item earns a row even though it has no park", () => {
    // The second of the two positive signals, so the guard cannot be
    // satisfied by a fixture that only ever exercises `quotaPark`.
    const stateDir = freshStateDir();
    writeFileSync(
      join(stateDir, "drive-pr-7032.json"),
      JSON.stringify({
        ...freshState(7032),
        parked: [
          { key: "PRRT_x", kind: "thread", reason: "needs a human", round: 1 },
        ],
      }),
    );
    expect(listStateOnlyRows(stateDir, []).map((r) => r.key)).toEqual(["7032"]);
  });

  it("a state dir that vanishes (ENOENT) between listRows and this census is a benign TOCTOU — empty rows, no throw", () => {
    // `listRows` already read (or fatally failed on) this exact directory
    // moments ago in the real call sequence, so a directory that is
    // genuinely GONE by the time this second read runs is not a fresh
    // failure — it is the narrow window this function's own header
    // documents. Exercised directly (unit-level, not through a subprocess)
    // so it is not conflated with the non-ENOENT case below, which must
    // behave differently.
    expect(listStateOnlyRows("/nonexistent/drive-pr-test-dir-xyz", [])).toEqual(
      [],
    );
  });

  it("a non-ENOENT failure to read the state dir fails CLOSED rather than reporting an empty population", () => {
    // A regular FILE where a directory is expected makes `readdirSync` throw
    // ENOTDIR on every platform, deterministically and without depending on
    // permission bits a root-run test could bypass — the portable stand-in for
    // "a transient permission, descriptor, or I/O error". Before the fix, this
    // and the ENOENT case above were indistinguishable: both silently became
    // `[]`, hiding exactly the quota-parked and human-parked drives whose
    // normal exit already removed their lock directories — the entire reason
    // this second census exists.
    const notADir = join(freshStateDir(), "this-is-a-file-not-a-dir");
    writeFileSync(notADir, "");
    let thrown: unknown;
    try {
      listStateOnlyRows(notADir, []);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ExitError);
    expect((thrown as ExitError).code).toBe(1);
  });
});

describe("gatherWorktreeLeftovers", () => {
  function scratchRepo(): { dir: string; home: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "leftovers-repo-"));
    const home = mkdtempSync(join(tmpdir(), "leftovers-home-"));
    const env = cleanEnv({ HOME: home });
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: dir, env });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "leftovers-probe@example.invalid");
    git("config", "user.name", "leftovers probe");
    writeFileSync(join(dir, "README.md"), "seed\n");
    git("add", ".");
    git("commit", "-q", "-m", "seed");
    return {
      dir,
      home,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  it('a clean repo with no upstream configured degrades to null (fail-closed, not "0 unpushed")', async () => {
    // No `git remote`/`--set-upstream` at all — `@{u}` cannot resolve.
    const repo = scratchRepo();
    try {
      expect(await gatherWorktreeLeftovers(repo.dir)).toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  it("a nonexistent worktree path degrades to null rather than reading the caller's own cwd", async () => {
    expect(
      await gatherWorktreeLeftovers("/definitely/does/not/exist/anywhere"),
    ).toBeNull();
  });

  function withBareOrigin(repo: { dir: string; home: string }): {
    bareDir: string;
    cleanup: () => void;
  } {
    const bareDir = mkdtempSync(join(tmpdir(), "leftovers-origin-"));
    const env = cleanEnv({ HOME: repo.home });
    Bun.spawnSync(["git", "init", "-q", "--bare", bareDir], { env });
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo.dir, env });
    git("remote", "add", "origin", bareDir);
    git("push", "-q", "-u", "origin", "main");
    return {
      bareDir,
      cleanup: () => rmSync(bareDir, { recursive: true, force: true }),
    };
  }

  it("a clean repo WITH a resolvable upstream and nothing ahead reports all-false leftovers", async () => {
    const repo = scratchRepo();
    const origin = withBareOrigin(repo);
    try {
      const leftovers = await gatherWorktreeLeftovers(repo.dir);
      expect(leftovers).toEqual({
        uncommitted: false,
        unpushed: false,
        unconcludedOp: null,
      });
    } finally {
      origin.cleanup();
      repo.cleanup();
    }
  });

  it("an uncommitted change is reported, unpushed and unconcludedOp untouched", async () => {
    const repo = scratchRepo();
    const origin = withBareOrigin(repo);
    try {
      writeFileSync(join(repo.dir, "dirty.txt"), "uncommitted\n");
      const leftovers = await gatherWorktreeLeftovers(repo.dir);
      expect(leftovers).toEqual({
        uncommitted: true,
        unpushed: false,
        unconcludedOp: null,
      });
    } finally {
      origin.cleanup();
      repo.cleanup();
    }
  });

  it("a local commit ahead of the pushed upstream is reported as unpushed", async () => {
    const repo = scratchRepo();
    const origin = withBareOrigin(repo);
    const env = cleanEnv({ HOME: repo.home });
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: repo.dir, env });
    try {
      writeFileSync(join(repo.dir, "more.txt"), "more\n");
      git("add", ".");
      git("commit", "-q", "-m", "ahead of origin");
      const leftovers = await gatherWorktreeLeftovers(repo.dir);
      expect(leftovers).toEqual({
        uncommitted: false,
        unpushed: true,
        unconcludedOp: null,
      });
    } finally {
      origin.cleanup();
      repo.cleanup();
    }
  });

  it("an unconcluded MERGE_HEAD is named, independent of uncommitted/unpushed state", async () => {
    const repo = scratchRepo();
    const origin = withBareOrigin(repo);
    try {
      // A real merge conflict is unnecessary — the probe only checks for the
      // MARKER FILE's presence (`unconcludedGitOpMarker`), so planting it
      // directly is the same fixture technique `proc.ts`'s own tests use.
      writeFileSync(
        join(repo.dir, ".git", "MERGE_HEAD"),
        `${"a".repeat(40)}\n`,
      );
      const leftovers = await gatherWorktreeLeftovers(repo.dir);
      expect(leftovers?.unconcludedOp).toBe("MERGE_HEAD");
    } finally {
      origin.cleanup();
      repo.cleanup();
    }
  });
});
