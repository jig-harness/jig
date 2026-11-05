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
