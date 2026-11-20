/**
 * The live drivers on the host that no launch record holding its stage
 * accounts for hold a slot of the account their passes bill: a drive a
 * pickup armed after the pickup's record ended, and one started by hand.
 * A driver whose process is gone holds nothing. The drivers are lock rows
 * of a drive database under a state root of the test's own.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { lockIdentity } from "../../shared/liveness.ts";
import { driveDb } from "../../skills/drive-pr/scripts/lib/state/db.ts";
import { takeLockRow } from "../../skills/drive-pr/scripts/lib/state/lock.ts";
import {
  admitHostDriverTakeover,
  admitRearm,
  slotTable,
} from "../lib/accounts.ts";
import { exitedPid, holdLock } from "./host-driver-fixtures.ts";
import {
  readCloneKey,
  readHostDrivers,
  type HostDriver,
  unrecordedDrivers,
} from "../lib/host-drivers.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import type { MachineAccount } from "../lib/machine-config.ts";

const PASS = { kind: "pass", deadlineSec: 5400, codex: { on: true } } as const;

const account = (name: string, identity: string): MachineAccount => ({
  name,
  vendor: "claude",
  configDir: `/config/${name}`,
  identity,
  maxPerAccount: 1,
});

const ACCOUNTS = [account("a", "a@example.com"), account("b", "b@example.com")];

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function pickup(
  accountName: string,
  workspace: string,
  state: ReadRecord["state"],
): ReadRecord {
  const record: LaunchRecord = {
    version: 1,
    id: `pickup-${accountName}`,
    token: "t",
    action: "pickup",
    repo: "o/r",
    repoPath: "/tmp/r",
    pr: null,
    item: "#12",
    account: accountName,
    vendor: "claude",
    configDir: `/config/${accountName}`,
    wallBackoffMs: 1000,
    replaces: null,
    facts: "f",
    createdAt: "2026-11-19T09:00:00.000Z",
    workspace: { id: "w", path: workspace },
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
  };
  return { record, state, result: null };
}

const ALIVE: ReadRecord["state"] = {
  kind: "alive",
  process: {
    hostId: "",
    host: "h",
    bootId: "b",
    pid: 1,
    start: "s",
    claimedAt: "2026-11-19T09:00:00.000Z",
  },
};
const ENDED: ReadRecord["state"] = {
  kind: "ended",
  exit: { code: 0, signal: null, at: "2026-11-19T09:30:00.000Z" },
  process: null,
};

function drivers(root: string): HostDriver[] {
  const read = readHostDrivers(root);
  if (!read.ok) throw new Error(read.failure.reason);
  return [...read.value];
}

function held(records: ReadRecord[], found: HostDriver[]) {
  return Object.fromEntries(
    slotTable(
      ACCOUNTS,
      records,
      Date.now(),
      tempDir("walls-"),
      undefined,
      found,
    ).map((s) => [s.account.name, s.held]),
  );
}

describe("a live driver no holding launch record accounts for", () => {
  it("armed by a pickup whose record has ended holds one slot on the pickup's account, and admission refuses a launch past the cap", () => {
    const root = tempDir("host-drivers-");
    const tree = join(root, "pickup-tree");
    mkdirSync(tree);
    holdLock(root, 41, tree, "a@example.com");
    const found = drivers(root);
    expect(found.map((d) => d.pr)).toEqual([41]);

    // While the pickup runs, its drive shares the pickup's slot.
    expect(held([pickup("a", tree, ALIVE)], found)).toEqual({ a: 1, b: 0 });
    // Once the pickup ends, the drive keeps the slot rather than freeing it.
    const ended = [pickup("a", tree, ENDED)];
    expect(held(ended, found)).toEqual({ a: 1, b: 0 });
    expect(unrecordedDrivers(ACCOUNTS, ended, found)).toEqual([
      expect.objectContaining({
        account: "a",
        startedBy: "pickup",
        record: "pickup-a",
      }),
    ]);

    const table = slotTable(
      [ACCOUNTS[0] as MachineAccount],
      ended,
      Date.now(),
      tempDir("walls-"),
      undefined,
      found,
    );
    const admission = admitRearm(table, null, PASS);
    expect("waits" in admission && admission.waits).toContain(
      "no account has a free slot",
    );
  });

  it("whose identity resolved to nothing counts on the account of the ended pickup that armed it", () => {
    const root = tempDir("host-drivers-");
    const tree = join(root, "pickup-tree");
    mkdirSync(tree);
    holdLock(root, 42, tree, null);
    expect(held([pickup("b", tree, ENDED)], drivers(root))).toEqual({
      a: 0,
      b: 1,
    });
  });

  it("started by hand with no launch record counts against the account its pass environment names", () => {
    const root = tempDir("host-drivers-");
    holdLock(root, 43, join(root, "hand-tree"), "B@example.com");
    const found = drivers(root);
    expect(held([], found)).toEqual({ a: 0, b: 1 });
    expect(unrecordedDrivers(ACCOUNTS, [], found)).toEqual([
      expect.objectContaining({
        account: "b",
        accountReason: null,
        startedBy: "unrecorded",
        record: null,
      }),
    ]);
  });

  it("billing an identity no listed account has is listed and holds no slot", () => {
    const root = tempDir("host-drivers-");
    holdLock(root, 44, join(root, "hand-tree"), "stranger@example.com");
    const found = drivers(root);
    expect(held([], found)).toEqual({ a: 0, b: 0 });
    expect(unrecordedDrivers(ACCOUNTS, [], found)).toEqual([
      expect.objectContaining({
        account: null,
        accountReason: expect.stringContaining("stranger@example.com"),
      }),
    ]);
  });

  it("billing another listed account than its tree's holding record holds that account's slot too", () => {
    const root = tempDir("host-drivers-");
    const tree = join(root, "pickup-tree");
    mkdirSync(tree);
    holdLock(root, 46, tree, "b@example.com");
    expect(held([pickup("a", tree, ALIVE)], drivers(root))).toEqual({
      a: 1,
      b: 1,
    });
  });

  it("billing an identity no listed account has holds no slot, even after an ended pickup of its tree", () => {
    const root = tempDir("host-drivers-");
    const tree = join(root, "pickup-tree");
    mkdirSync(tree);
    holdLock(root, 47, tree, "stranger@example.com");
    expect(held([pickup("a", tree, ENDED)], drivers(root))).toEqual({
      a: 0,
      b: 0,
    });
  });

  it("billing an identity no listed account has stays listed beside its tree's live record, with no account", () => {
    const root = tempDir("host-drivers-");
    const tree = join(root, "pickup-tree");
    mkdirSync(tree);
    holdLock(root, 48, tree, "stranger@example.com");
    const found = drivers(root);
    expect(held([pickup("a", tree, ALIVE)], found)).toEqual({ a: 1, b: 0 });
    expect(
      unrecordedDrivers(ACCOUNTS, [pickup("a", tree, ALIVE)], found),
    ).toEqual([
      expect.objectContaining({
        account: null,
        accountReason: expect.stringContaining("stranger@example.com"),
      }),
    ]);
  });

  it("frees its slot once its process is gone", () => {
    const root = tempDir("host-drivers-");
    holdLock(root, 45, join(root, "hand-tree"), "a@example.com", {
      ...lockIdentity(),
      pid: exitedPid(),
    });
    expect(drivers(root)).toEqual([]);
    expect(held([], drivers(root))).toEqual({ a: 0, b: 0 });
  });

  it("transfers a wedged holder's occupied last slot to its takeover", () => {
    const root = tempDir("host-drivers-");
    holdLock(root, 49, join(root, "wedged-tree"), "a@example.com");
    const table = slotTable(
      [ACCOUNTS[0] as MachineAccount],
      [],
      Date.now(),
      tempDir("walls-"),
      undefined,
      drivers(root),
    );
    expect(table[0]?.held).toBe(1);
    expect(
      admitHostDriverTakeover(
        table,
        "a",
        PASS.deadlineSec,
        PASS.codex,
        "rearm",
      ),
    ).toMatchObject({ admitted: { account: { name: "a" } } });
  });
});

describe("the host's drivers", () => {
  it("are none on a host with no drive database", () => {
    expect(drivers(tempDir("host-drivers-"))).toEqual([]);
  });

  it("are read through the clone directory a driver's own environment names", () => {
    const root = tempDir("host-drivers-");
    holdLock(root, 48, join(root, "hand-tree"), "a@example.com");
    expect(readHostDrivers(join(root, "clone-a"))).toEqual(
      readHostDrivers(root),
    );
    expect(drivers(join(root, "clone-a"))).toHaveLength(1);
  });

  it("do not read, saying why, from a database that is not one", () => {
    const root = tempDir("host-drivers-");
    writeFileSync(join(root, "state.sqlite"), "not a database");
    const read = readHostDrivers(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? null : read.failure.reason).toContain(
      "the drive's database could not be read for its live drivers",
    );
  });

  it("leave a tree's worktree lock out: only a pull request's lock is a driver", () => {
    const root = tempDir("host-drivers-");
    const drive = driveDb(join(root, "clone-a"));
    takeLockRow(drive, "pr-drive-worktree-abc", null, {
      token: "worktree-token",
      label: "drive.ts",
      holder: lockIdentity(),
      detail: null,
    });
    expect(drivers(root)).toEqual([]);
  });
});

describe("a checkout's clone key", () => {
  it("is read from that checkout even when the environment names another repository's git directory", () => {
    const root = tempDir("host-drivers-");
    const [a, b] = ["clone-a", "clone-b"].map((name) => {
      const path = join(root, name);
      mkdirSync(path);
      expectSpawnExit(Bun.spawnSync(["git", "-C", path, "init", "-q"]), 0);
      writeFileSync(
        join(path, ".git", "drive-pr-clone-id"),
        `${randomUUID()}\n`,
      );
      return path;
    }) as [string, string];
    const read = (path: string, env: Record<string, string>) => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { readCloneKey } from ${JSON.stringify(join(import.meta.dir, "../lib/host-drivers.ts"))};console.log(readCloneKey(${JSON.stringify(path)}))`,
        ],
        { env: { ...process.env, ...env } },
      );
      expectSpawnExit(child, 0);
      return child.stdout.toString().trim();
    };
    const own = read(a, {});
    expect(own).not.toBe("null");
    expect(read(b, {})).not.toBe(own);
    expect(read(a, { GIT_DIR: join(b, ".git") })).toBe(own);
  });

  it("is the clone's own key from a linked worktree, whose .git is a file", () => {
    const root = tempDir("host-drivers-");
    const main = join(root, "main");
    const linked = join(root, "linked");
    mkdirSync(main);
    const git = (...args: string[]) =>
      expectSpawnExit(
        Bun.spawnSync([
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "-C",
          main,
          ...args,
        ]),
        0,
      );
    git("init", "-q");
    writeFileSync(join(main, ".git", "drive-pr-clone-id"), `${randomUUID()}\n`);
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("worktree", "add", "-q", "--detach", linked);
    const key = readCloneKey(main);
    expect(key).not.toBeNull();
    expect(readCloneKey(linked)).toBe(key);
  });
});
