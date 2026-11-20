/**
 * What a held pickup costs the tracker. The checks this host makes alone (an
 * account with a free slot, the host's load) come before a pickup's fresh
 * tracker reads, so a launch they hold sends none; a launch they pass still
 * reads the item, its relations and its assignment again; and the person a
 * tick's candidates are served for is looked up once.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotTable } from "../lib/accounts.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import { applyPickups, type PickupContext } from "../lib/actions/pickup.ts";
import { loadState } from "../lib/load.ts";
import { LOAD_DEFAULTS } from "../lib/load-config.ts";
import type { LoadReading } from "../lib/load-read.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import { closeStateDb } from "../lib/state.ts";
import type { Action, RepoReport } from "../lib/types.ts";
import { currentMs } from "../../shared/time.ts";
import { FakeLinear } from "./served-linear-fake.ts";

const PERSON = "person@example.com";
const REPO = "example/repo";
const GIB = 1024 ** 3;
/** The per-item reads of a pickup's fresh check. */
const PER_ITEM = [
  "TrackerAssignmentHistory",
  "TrackerRelations",
  "TrackerInverseRelations",
  "TrackerUsers",
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-local-holds-"));
  dirs.push(dir);
  return dir;
}

/** Three items assigned to the served person, each waiting on a finished issue. */
function workspace(): FakeLinear {
  const fake = new FakeLinear();
  for (let n = 1; n <= 3; n++) {
    fake.add({
      identifier: `ENG-${100 + n}`,
      state: { name: "Done", type: "completed" },
    });
    fake.add({
      identifier: `ENG-${n}`,
      assignee: PERSON,
      blockedBy: [`ENG-${100 + n}`],
    });
  }
  return fake;
}

/** An account whose configuration directory resolves to another login, so its identity check refuses it. */
function account(root: string): MachineAccount {
  const configDir = join(root, "work");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "other@example.com" } }),
  );
  return {
    name: "work",
    vendor: "claude",
    configDir,
    identity: "work@example.com",
    maxPerAccount: 4,
  };
}

/** A 16 GiB host with `free` bytes available, idle otherwise. */
function reading(free: number): LoadReading {
  return {
    host: { load1: 0.1, cores: 8, availableBytes: free },
    totalBytes: 16 * GIB,
    platform: "linux",
    disk: { freeBytes: 500 * GIB, totalBytes: 1000 * GIB, path: "/ws" },
    lock: { holders: 0, waiters: 0 },
    forge: { remaining: 4000, limit: 5000 },
    sessions: null,
  };
}

/** The apply state of one account, under a load (enforced unless `enforce` says not) with `free` bytes available. */
function applyState(root: string, free: number, enforce = true): ApplyState {
  const accounts = [account(root)];
  return {
    machine: {
      accounts,
      serve: [
        { name: "Person", forge: ["person"], tracker: { linear: PERSON } },
      ],
      runtimeTimeoutMs: 30_000,
    },
    runtime: { name: "orca" },
    records: [],
    table: slotTable(accounts, [], currentMs(), root),
    last: null,
    passDeadlineSec: 5400,
    codexOptIn: { on: true },
    root,
    load: loadState(
      { ...LOAD_DEFAULTS, enforce },
      reading(free),
      { held: 0, capacity: 4 },
      new Map(),
    ),
  } as unknown as ApplyState;
}

function context(fake: FakeLinear): PickupContext {
  return {
    tracker: fake.tracker(),
    section: { identity: null, pickupDeadlineMs: 3_600_000 },
    branchPattern: "{key_lower}-{slug}",
    sessions: async () => ({ ok: true, source: "fake", workspaces: [] }),
    servedPolicy: {},
  } as unknown as PickupContext;
}

const served = (key: string): Action => ({
  stage: "pickup",
  target: key,
  record: "tracker",
  reason: "ready",
  evidence: { servedPerson: PERSON },
});

async function apply(state: ApplyState, fake: FakeLinear) {
  const report = {
    actions: ["ENG-1", "ENG-2", "ENG-3"].map(served),
    launches: [],
  } as unknown as RepoReport;
  await applyPickups(
    state,
    { path: "/r", slug: REPO, defaultBranch: "main" } as never,
    report,
    context(fake),
  );
  return report.launches;
}

const count = (fake: FakeLinear, op: string) =>
  fake.requests.filter((r) => r === op).length;

describe("a pickup's fresh tracker reads", () => {
  it("are not sent for a launch the host's load holds", async () => {
    const fake = workspace();
    const state = applyState(scratch(), 1 * GIB);
    const launches = await apply(state, fake);
    expect(launches).toHaveLength(3);
    for (const launch of launches)
      expect(launch).toMatchObject({
        outcome: "waits",
        detail: expect.stringContaining("the host's load holds it"),
      });
    for (const op of PER_ITEM) expect(count(fake, op)).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(state.load?.holds.map((h) => h.target)).toEqual([
      "ENG-1",
      "ENG-2",
      "ENG-3",
    ]);
  });

  it("are sent without enforcement, which leaves the load's report to the admission that follows", async () => {
    const fake = workspace();
    const state = applyState(scratch(), 1 * GIB, false);
    const launches = await apply(state, fake);
    expect(count(fake, "TrackerAssignmentHistory")).toBe(3);
    // The identity check refuses each launch before the load judges it, and nothing was recorded earlier.
    for (const launch of launches)
      expect(launch).toMatchObject({ outcome: "refused" });
    expect(state.load?.holds).toEqual([]);
  }, 60_000);

  it("are not sent for a launch no account has a slot for", async () => {
    const fake = workspace();
    const state = applyState(scratch(), 12 * GIB);
    state.table = [];
    const launches = await apply(state, fake);
    for (const launch of launches)
      expect(launch).toMatchObject({
        outcome: "waits",
        detail: expect.stringContaining("no account has a free slot"),
      });
    expect(fake.requests).toEqual([]);
  });

  it("are sent for a launch the host would start, before its account is admitted", async () => {
    const fake = workspace();
    const launches = await apply(applyState(scratch(), 12 * GIB), fake);
    // Each candidate passes the local checks and its fresh reads, then its account's identity check refuses it.
    for (const launch of launches)
      expect(launch).toMatchObject({
        outcome: "refused",
        detail: expect.stringContaining("identity check"),
      });
    expect(count(fake, "TrackerPoolIssue")).toBeGreaterThanOrEqual(3);
    expect(count(fake, "TrackerRelations")).toBe(3);
    expect(count(fake, "TrackerInverseRelations")).toBe(3);
    expect(count(fake, "TrackerAssignmentHistory")).toBe(3);
  }, 60_000);

  it("look up the served person once for several candidates in one tick", async () => {
    const fake = workspace();
    await apply(applyState(scratch(), 12 * GIB), fake);
    expect(count(fake, "TrackerUsers")).toBe(1);
  }, 60_000);
});
