/**
 * A launch record's claim judged by the shared process identity
 * (`shared/liveness.ts`), through the dispatcher's own reader: a launch
 * claimed on this host before it restarted has died, one claimed on another
 * host stays unknown, and one claimed under the host's earlier name is judged
 * by its process.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureIdentity, thisHost } from "../../shared/liveness.ts";
import {
  claimRecord,
  holds,
  type LaunchClaim,
  type LaunchRecord,
  readLaunches,
  writeRecord,
} from "../lib/launches.ts";
import {
  asClaim,
  claimState,
  registerStageProcess,
  uncertainStage,
} from "../lib/launch-supervision.ts";
import { clearMain } from "../clear.ts";
import { classifyEnded } from "../lib/log.ts";
import { closeStateDb } from "../lib/state.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true });
  }
});

const ID = "20261104T090000Z-aaaaaaaa";

function claimedRoot(claim: LaunchClaim): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-liveness-"));
  dirs.push(dir);
  const record: LaunchRecord = {
    version: 1,
    id: ID,
    token: "t",
    action: "rearm",
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "generation 1, exit 8, heartbeat x",
    createdAt: "2026-11-04T09:00:00.000Z",
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
  };
  writeRecord(record, dir);
  expect(claimRecord(ID, claim, dir)).toBe(true);
  return dir;
}

/** This process's claim, as its wrapper would have written it. */
async function ownClaim(): Promise<LaunchClaim> {
  const captured = await captureIdentity();
  if (!captured.ok) throw new Error(captured.failure.reason);
  return { ...captured.value, claimedAt: "2026-11-04T09:00:01.000Z" };
}

describe("a launch record's claim, judged by the shared process identity", () => {
  it("holds a dead wrapper's slot while its durable stage child is alive", async () => {
    const child = await ownClaim();
    const claim = {
      ...child,
      pid: 2147483647,
      supervision: { supervisor: child, child },
    };
    const dir = claimedRoot(claim);
    const { records } = await readLaunches(dir);
    expect(records[0]?.state.kind).toBe("unknown");
    expect(records[0] !== undefined && holds(records[0].state)).toBe(true);
  });

  it("holds a dead wrapper's slot when the child launch handoff was interrupted", async () => {
    const claim = {
      ...(await ownClaim()),
      pid: 2147483647,
      supervision: { supervisor: null, child: null },
    };
    const { records } = await readLaunches(claimedRoot(claim));
    expect(records[0]?.state.kind).toBe("unknown");
    expect(records[0] !== undefined && holds(records[0].state)).toBe(true);
  });

  it("keeps malformed supervision unknown instead of reading a wrapper-only legacy claim", async () => {
    const claim = {
      ...(await ownClaim()),
      pid: 2147483647,
      supervision: { supervisor: {}, child: null },
    };
    const { records } = await readLaunches(
      claimedRoot(claim as unknown as LaunchClaim),
    );
    expect(records[0]?.state.kind).toBe("unknown");
    expect(asClaim(claim)).toBeNull();
  });

  it("keeps missing cleanup evidence unknown even when every recorded process has died or its pid was reused", async () => {
    const identity = await ownClaim();
    const dead = { ...identity, pid: 2147483647 };
    const claim = {
      ...dead,
      supervision: {
        supervisor: dead,
        child: { ...identity, start: "an-earlier-start" },
      },
    };
    const { records } = await readLaunches(claimedRoot(claim));
    expect(records[0]?.state.kind).toBe("unknown");
    expect(records[0] !== undefined && holds(records[0].state)).toBe(true);
    expect(claimState(claim, null, thisHost()).kind).toBe("unknown");
  });

  it("holds uncertain cleanup after process death, but a reboot proves its processes gone", async () => {
    const identity = await ownClaim();
    const dead = { ...identity, pid: 2147483647 };
    const claim = { ...dead, supervision: { supervisor: dead, child: dead } };
    const root = claimedRoot(claim);
    uncertainStage(ID, root);
    const { records } = await readLaunches(root);
    expect(records[0]?.state.kind).toBe("unknown");
    const reboot = await readLaunches(root, {
      ...thisHost(),
      bootId: "new-boot",
    });
    expect(reboot.records[0]?.state.kind).toBe("died");
  });

  it("acknowledges each process once and refuses the wrong token or registering owner", async () => {
    const identity = await ownClaim();
    const root = claimedRoot({
      ...identity,
      supervision: { supervisor: null, child: null },
    });
    expect(
      registerStageProcess(ID, "wrong", "supervisor", identity, identity, root)
        .ok,
    ).toBe(false);
    expect(
      registerStageProcess(
        ID,
        "t",
        "supervisor",
        identity,
        { ...identity, start: "wrong" },
        root,
      ).ok,
    ).toBe(false);
    expect(
      registerStageProcess(ID, "t", "supervisor", identity, identity, root).ok,
    ).toBe(true);
    expect(
      registerStageProcess(ID, "t", "supervisor", identity, identity, root).ok,
    ).toBe(false);
    expect(
      registerStageProcess(ID, "t", "child", identity, identity, root).ok,
    ).toBe(true);
    expect(
      registerStageProcess(ID, "t", "child", identity, identity, root).ok,
    ).toBe(false);
  });

  it("refuses manual clearance while a dead wrapper's registered child runs, including uncertain cleanup", async () => {
    const child = await ownClaim();
    for (const uncertain of [false, true]) {
      const root = claimedRoot({
        ...child,
        pid: 2147483647,
        supervision: { supervisor: null, child },
      });
      if (uncertain) uncertainStage(ID, root);
      expect(await clearMain(ID, root)).toBe(2);
      const { records } = await readLaunches(root);
      expect(records).toHaveLength(1);
      expect(records[0]?.state.kind).toBe("unknown");
    }
  });

  it("reads a launch claimed on this host before it restarted as died, and its outcome row says why", async () => {
    const claim = { ...(await ownClaim()), bootId: "boot-before" };
    const dir = claimedRoot(claim);
    const here = { ...thisHost(), bootId: "boot-now" };
    const { records } = await readLaunches(dir, here);
    const [read] = records;
    if (read === undefined) throw new Error("the record does not read");
    expect(read.state.kind).toBe("died");
    expect(holds(read.state)).toBe(false);
    const ended = classifyEnded(read, "2026-11-04T10:00:00.000Z", {
      takenOver: false,
      merged: null,
    });
    expect(ended.class).toBe("died");
    expect(ended.reason).toContain("ran before this host last restarted");
  });

  it("keeps a launch claimed on another host unknown, holding its slot", async () => {
    const claim = { ...(await ownClaim()), hostId: "f".repeat(32) };
    const dir = claimedRoot(claim);
    const { records } = await readLaunches(dir);
    const state = records[0]?.state;
    expect(state?.kind).toBe("unknown");
    expect(state !== undefined && holds(state)).toBe(true);
    expect(state?.kind === "unknown" && state.reason).toContain(
      "is on another host",
    );
  });

  it("judges a launch claimed under the host's earlier name by its process", async () => {
    const claim = { ...(await ownClaim()), host: "an-earlier-name.local" };
    const dir = claimedRoot(claim);
    const { records } = await readLaunches(dir);
    expect(records[0]?.state.kind).toBe("alive");
  });

  it("still reads a claim written before host ids, by its host name", async () => {
    const { hostId: _, ...older } = await ownClaim();
    const dir = claimedRoot(older as LaunchClaim);
    const { records } = await readLaunches(dir);
    expect(records[0]?.state.kind).toBe("alive");
  });
});
