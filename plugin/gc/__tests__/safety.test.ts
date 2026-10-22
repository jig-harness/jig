import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "../git.ts";
import { scratchProof } from "../kinds/scratch.ts";
import { reaperEnvironment } from "../kinds/tool-state.ts";
import { receiptsKind } from "../kinds/receipts.ts";
import { sharedGcLock, exclusiveGcLock } from "../../shared/gc-lock.ts";
import { SCRATCH_OWNER_FILE } from "../../shared/scratch-owner.ts";
import { boundDeclaration, parseDeclaration, parseMachine } from "../config.ts";
import { jobFiles } from "../scheduler.ts";
import { argumentsFor, scheduledCollection } from "../cli.ts";
import { readReceipt, writeReceipt, receiptPaths } from "../receipts.ts";
import type { Receipt } from "../types.ts";

const root = () => mkdtempSync(join(tmpdir(), "gc-safety-"));
function record(dir: string, pid: number, start: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, SCRATCH_OWNER_FILE),
    JSON.stringify({
      version: 1,
      pid,
      start,
      createdAt: "2000-01-01T00:00:00.000Z",
    }),
  );
}
const later = Date.now() + 10 * 86_400_000;
test("an old scope without registration is a finding", () => {
  expect(scratchProof(root(), [], 7, later).state).toBe("finding");
});
test("an owner in a nested scope vetoes its dead parent's collection", () => {
  const dir = root();
  record(dir, 1, "old");
  record(join(dir, "child"), 2, "live");
  const proof = scratchProof(
    dir,
    [{ pid: 2, start: "live", ppid: 0, pgid: 2, stat: "R", args: "" }],
    7,
    later,
  );
  expect(proof.state).toBe("live");
});
test("reused pids do not revive an owner, but scratch still reports only", () => {
  const dir = root();
  record(dir, 2, "old");
  expect(
    scratchProof(
      dir,
      [{ pid: 2, start: "new", ppid: 0, pgid: 2, stat: "R", args: "" }],
      7,
      later,
    ),
  ).toMatchObject({ state: "dead", reportOnly: expect.any(String) });
});
test("unreadable identities and process tables fail closed", () => {
  const dir = root();
  record(dir, 2, "old");
  expect(scratchProof(dir, null, 7, later).state).toBe("unverified");
  expect(
    scratchProof(
      dir,
      [{ pid: 2, start: "", ppid: 0, pgid: 2, stat: "R", args: "" }],
      7,
      later,
    ).state,
  ).toBe("unverified");
});
test("malformed child ownership prevents proving the parent dead", () => {
  const dir = root();
  record(dir, 1, "old");
  mkdirSync(join(dir, "child"));
  writeFileSync(join(dir, "child", SCRATCH_OWNER_FILE), "{}");
  expect(() => scratchProof(dir, [], 7, later)).toThrow(
    "Invalid scratch owner",
  );
});
test("reader and writer admission exclude each other", async () => {
  const dir = root();
  const release = sharedGcLock("scratch", dir);
  await expect(
    exclusiveGcLock(
      "scratch",
      async () => {
        /* The reader must prevent entry. */
      },
      dir,
    ),
  ).rejects.toThrow("creator holds");
  release();
  await exclusiveGcLock(
    "scratch",
    async () => {
      expect(() => sharedGcLock("scratch", dir)).toThrow(
        "collection in progress",
      );
    },
    dir,
  );
  expect(readdirSync(join(dir, "scratch"))).toEqual([]);
});
test("repository declarations cannot register commands or production kinds", () => {
  expect(() => parseDeclaration({ command: "rm -rf" }, "/repo")).toThrow(
    "Unknown gc.command",
  );
  expect(() => parseDeclaration({ kinds: ["production"] }, "/repo")).toThrow(
    "supports",
  );
  expect(() => parseDeclaration({ scratch_prefixes: ["/"] }, "/repo")).toThrow(
    "filesystem root",
  );
});
test("a base change can only narrow the confirmed install bounds", () => {
  const installed = parseDeclaration(
    { kinds: ["scratch"], scratch_prefixes: ["/tmp/test-"] },
    "/repo",
  );
  const current = parseDeclaration(
    {
      kinds: ["scratch", "worktrees"],
      scratch_prefixes: ["/tmp/test-", "/tmp/"],
    },
    "/repo",
  );
  const result = boundDeclaration(current, installed);
  expect(result.widened).toBe(true);
  expect(result.declaration).toEqual(installed);
});
test("a scratch scan past its deadline refuses rather than stalling", () => {
  const scope = root();
  writeFileSync(join(scope, SCRATCH_OWNER_FILE), "{}");
  expect(() => scratchProof(scope, [], 7, Date.now(), 0)).toThrow(
    "exceeded its deadline",
  );
});
test("machine guards cannot shorten the kind's default or add authority", () => {
  expect(() => parseMachine({ idle_days: { scratch: 1 } })).toThrow(
    "integer from 7",
  );
  expect(() => parseMachine({ scratch_prefixes: ["/tmp/"] })).toThrow(
    "Unknown",
  );
  expect(() => parseMachine({ hour: 24 })).toThrow("integer");
});
test("the schedule reports daily and collects weekly or under pressure", () => {
  const policy = { collect_day: 0, min_free_bytes: 100 };
  expect(scheduledCollection(policy, new Date(2026, 9, 19), 200)).toBe(false);
  expect(scheduledCollection(policy, new Date(2026, 9, 18), 200)).toBe(true);
  expect(scheduledCollection(policy, new Date(2026, 9, 19), 50)).toBe(true);
});
test("scheduler files preserve exact argv and explicit environment", () => {
  const job = {
    command: ["/opt/bun", "/cache/jig's plugin/jig.ts", "gc", "--scheduled"],
    env: { PATH: "/bin:/a b", JIG_HOME: "/a&b" },
    hour: 4,
  };
  expect(jobFiles("launchd", job)["dev.jig.gc.plist"]).toContain("/a&amp;b");
  expect(jobFiles("systemd", job)["jig-gc.service"]).toContain(
    '"/cache/jig\'s plugin/jig.ts"',
  );
  expect(jobFiles("cron", job).crontab).toContain("'\\''");
  expect(() => jobFiles("cron", { ...job, command: ["bad\ncommand"] })).toThrow(
    "line breaks",
  );
  expect(
    jobFiles("cron", { ...job, env: { LOCK_NAME: "50%" } }).crontab,
  ).toContain("'LOCK_NAME=50\\%'");
  expect(() =>
    jobFiles("cron", { ...job, env: { LOCK_NAME: "a\\%b" } }),
  ).toThrow("backslash before %");
});
test("bad arguments are refused before a sweep", () => {
  for (const args of [
    ["--kind", "unknown"],
    ["--repo"],
    ["--wat"],
    ["--collect", "--scheduled"],
    ["--machine"],
  ])
    expect(() => argumentsFor(args)).toThrow();
});
function receipt(
  runId: string,
  date: string,
  kind: "scratch" | "worktrees",
): Receipt {
  return {
    version: 1,
    runId,
    startedAt: date,
    finishedAt: date,
    collect: false,
    completed: true,
    kinds: [{ name: kind, repository: "/repo", declaration: "fixture" }],
    resources: [],
    exitStatus: 0,
  };
}
test("receipt retention preserves the latest run of each kind", async () => {
  const dir = root();
  const old = writeReceipt(
    receipt(
      "2000-01-01T00-00-00.000Z-1-abcd",
      "2000-01-01T00:00:00.000Z",
      "scratch",
    ),
    dir,
  );
  const kept = writeReceipt(
    receipt(
      "2000-01-02T00-00-00.000Z-1-abcd",
      "2000-01-02T00:00:00.000Z",
      "worktrees",
    ),
    dir,
  );
  writeReceipt(
    receipt(
      "2000-01-03T00-00-00.000Z-1-abcd",
      "2000-01-03T00:00:00.000Z",
      "scratch",
    ),
    dir,
  );
  const kind = receiptsKind(30, dir);
  expect(receiptPaths(dir)).toHaveLength(3);
  expect((await kind.prove({ id: old })).state).toBe("dead");
  expect((await kind.prove({ id: kept })).state).toBe("live");
});
test("a receipt whose dates would not sort chronologically is refused", () => {
  const dir = root();
  const path = writeReceipt(
    receipt("2000-10-01T00-00-00.000Z-1-abcd", "October 1, 2000", "scratch"),
    dir,
  );
  expect(() => readReceipt(path)).toThrow("Invalid collection receipt");
});

test("forge and Git identity overrides are scrubbed case-insensitively", () => {
  expect(
    gitEnvironment({
      GH_REPO: "wrong/repo",
      gh_repo: "wrong/repo",
      GIT_DIR: "/wrong",
      git_work_tree: "/wrong",
      DRIVE_PR_WORKTREE: "/wrong",
      JIG_OVERLAY: "/wrong",
      JIG__GC__KINDS: "[scratch]",
      PATH: "/bin",
    }),
  ).toEqual({ PATH: "/bin" });
});

test("the state reaper keeps the relocated state root but not worktree identity", () => {
  expect(
    reaperEnvironment("/repo", {
      DRIVE_PR_STATE_DIR: "/state",
      DRIVE_PR_WORKTREE: "/wrong",
      PATH: "/bin",
    }),
  ).toEqual({
    DRIVE_PR_STATE_DIR: "/state",
    JIG_CONSUMER_ROOT: "/repo",
    PATH: "/bin",
  });
});

test("systemd escapes command dollars while preserving environment dollars", () => {
  const files = jobFiles("systemd", {
    command: ["/opt/bun", "/cache/jig$version/jig.ts"],
    env: { JIG_HOME: "/a$b%c" },
    hour: 4,
  });
  expect(files["jig-gc.service"]).toContain(
    'ExecStart="/opt/bun" "/cache/jig$$version/jig.ts"',
  );
  expect(files["jig-gc.service"]).toContain('Environment="JIG_HOME=/a$b%%c"');
});

test("unfinished receipts retain their action evidence even past retention", async () => {
  const dir = root();
  const pending = receipt(
    "2000-01-01T00-00-00.000Z-1-abcd",
    "2000-01-01T00:00:00.000Z",
    "scratch",
  );
  pending.completed = false;
  const path = writeReceipt(pending, dir);
  writeReceipt(
    receipt(
      "2000-01-02T00-00-00.000Z-1-abcd",
      "2000-01-02T00:00:00.000Z",
      "scratch",
    ),
    dir,
  );
  expect((await receiptsKind(30, dir).prove({ id: path })).state).toBe(
    "unverified",
  );
});
