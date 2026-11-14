/**
 * A follow-up the host failed (its pass died, or its result could not be
 * written on the host) is run again once, only while the host's health check
 * passes, and never under `failures.rerun_died: 0`; a run again is never run
 * again, and a pass whose result went unwritten raises no question of its own.
 * The planning rule and the settlement that releases the marker, read from
 * their inputs.
 */
import { isoFromMs } from "../../shared/time.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRecord, LaunchState, ReadRecord } from "../lib/launches.ts";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { type FollowupInput, planFollowups } from "../lib/plan-followups.ts";
import { RECOVERY_FACTS } from "../lib/recovery-facts.ts";
import { settleRetryableFollowups } from "../lib/settlement.ts";
import type {
  Action,
  FollowupMarker,
  MarkedPr,
  RepoReport,
} from "../lib/types.ts";
import type { SharedRecords } from "../../shared/records/shared.ts";

const SLUG = "example-org/example-repo";
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const FIRST = "20261114T110000Z-aaaaaaaa";
const RERUN = "20261114T113000Z-bbbbbbbb";
const HELD =
  "the host's health check fails (dispatch:last-run: a tick exited 1)";
const QUESTION =
  "Question: should the dispatcher's state database schema be repaired?";

function followup(
  id: string,
  fields: Partial<LaunchRecord> = {},
): LaunchRecord {
  return {
    version: 1,
    id,
    token: `token-${id}`,
    action: "followup",
    repo: SLUG,
    repoPath: "/repo",
    pr: 9,
    item: null,
    account: "a",
    vendor: "claude",
    configDir: "/config",
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "merged 2026-11-14T10:00:00Z",
    createdAt: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:00.000Z`,
    workspace: { id: "ws", path: "/ws" },
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: "/followup",
    marker: 901,
    routineTags: true,
    ...fields,
  };
}

/** A pass that exited 1 at `at`, its last line `said`. */
function exited(at: string, said?: string): LaunchState {
  return {
    kind: "ended",
    exit: {
      at,
      code: 1,
      signal: null,
      ...(said === undefined ? {} : { said, context: said }),
    },
    process: null,
  };
}

const DIED: LaunchState = {
  kind: "died",
  reason: "its process is gone",
  process: {
    hostId: "",
    host: "here",
    bootId: "",
    pid: 1,
    start: "",
    claimedAt: "",
  },
};

/** A pass whose `jig dispatch result` the host's database refused, after it asked about that database. */
function unwritten(
  record: LaunchRecord,
  at = "2026-11-14T11:40:00.000Z",
): ReadRecord {
  return {
    record,
    state: exited(at, QUESTION),
    result: null,
    unwritten: at,
  };
}

function marker(record: string): FollowupMarker {
  return {
    id: 901,
    login: "drive-bot",
    createdAt: "2026-11-14T11:00:00.000Z",
    trusted: true,
    run: { kind: "tick", record, host: "host-a" },
  };
}

function merged(markers: FollowupMarker[]): MarkedPr {
  return {
    number: 9,
    url: "https://example.test/pr/9",
    title: "Done",
    head: "feature/9",
    mergedAt: "2026-11-14T10:00:00Z",
    markers,
  };
}

type Plan = Pick<RepoReport, "actions" | "running" | "unplaced" | "quiet">;

/** The plan for PR #9, with the follow-ups the tick wants beside it. */
function planned(
  pr: MarkedPr,
  launches: ReadRecord[],
  fields: Partial<FollowupInput> = {},
): Plan & { wanted: Action[] } {
  const plan: Plan = { actions: [], running: [], unplaced: [], quiet: [] };
  const wanted: Action[] = [];
  planFollowups(
    {
      slug: SLUG,
      command: "/followup",
      merged: [pr],
      launches,
      outcomes: new Map(),
      host: "host-a",
      sessions: { ok: true, source: "test", workspaces: [] },
      staleAfterMs: 6 * 3_600_000,
      releases: new Map(),
      owner: true,
      retried: new Set(),
      rerunsHeld: null,
      nowMs: NOW,
      ...fields,
    },
    plan,
    (action) => wanted.push(action),
  );
  return { ...plan, wanted };
}

const notified = (plan: Plan) =>
  plan.actions.filter((a) => a.stage === "notify");

describe("a follow-up whose result write failed", () => {
  it("releases its marker once the host's health check passes, whatever its pass asked", () => {
    const plan = planned(merged([marker(FIRST)]), [unwritten(followup(FIRST))]);
    expect(notified(plan)).toEqual([]);
    expect(plan.running).toEqual([
      expect.objectContaining({
        target: "PR #9",
        reason: expect.stringContaining(
          `launch record ${FIRST}'s pass could not record its result on this host: the tick releases its marker (comment 901)`,
        ),
      }),
    ]);
  });

  it("is held, with no failed follow-up and no question, while the host's health check fails", () => {
    const plan = planned(
      merged([marker(FIRST)]),
      [unwritten(followup(FIRST))],
      {
        rerunsHeld: HELD,
      },
    );
    expect(notified(plan)).toEqual([]);
    expect(plan.running).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining(`held while ${HELD}`),
      }),
    ]);
  });

  it("runs again once, as a recovery, after its marker was released, and not while the check fails", () => {
    const launches = [unwritten(followup(FIRST))];
    const released = { retried: new Set([FIRST]) };
    const healthy = planned(merged([]), launches, released);
    expect(healthy.wanted).toEqual([
      expect.objectContaining({
        stage: "followup",
        facts: expect.stringMatching(/^recovery: /),
        reason: expect.stringContaining(
          "could not record its result on this host: run /followup 9 again, once",
        ),
      }),
    ]);
    const held = planned(merged([]), launches, {
      ...released,
      rerunsHeld: HELD,
    });
    expect(held.wanted).toEqual([]);
    expect(held.quiet).toEqual([
      expect.objectContaining({
        class: "followup-held",
        why: expect.stringContaining(`held while ${HELD}`),
      }),
    ]);
  });

  it("has no age limit, as a death's run again has", () => {
    const old = unwritten(followup(FIRST), "2026-11-12T11:40:00.000Z");
    const plan = planned(merged([marker(FIRST)]), [old]);
    expect(notified(plan)).toEqual([]);
    expect(plan.running[0]?.reason).toContain("could not record its result");
  });
});

describe("a death older than the session lease", () => {
  const OLD = "20261113T010000Z-dddddddd";
  const old = (): ReadRecord => ({
    record: followup(OLD),
    state: DIED,
    result: null,
  });

  it("is held while the host's health check fails: no failed follow-up, nothing released", async () => {
    const plan = planned(merged([marker(OLD)]), [old()], { rerunsHeld: HELD });
    expect(notified(plan)).toEqual([]);
    expect(plan.running).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining(`held while ${HELD}`),
      }),
    ]);
    expect(await released([old()], HELD)).toEqual([]);
  });

  it("goes to a person once the check passes", () => {
    const plan = planned(merged([marker(OLD)]), [old()]);
    expect(plan.running).toEqual([]);
    expect(notified(plan)).toEqual([
      expect.objectContaining({ cause: "followup-failed" }),
    ]);
  });
});

describe("a run again", () => {
  const rerun = (fields: Partial<LaunchRecord> = {}) =>
    followup(RERUN, {
      facts: `${RECOVERY_FACTS}merged 2026-11-14T10:00:00Z`,
      ...fields,
    });

  it("whose result write failed again raises a need, without its pass's question, and is not run again", () => {
    const plan = planned(merged([marker(RERUN)]), [
      unwritten(followup(FIRST)),
      unwritten(rerun()),
    ]);
    expect(plan.running).toEqual([]);
    const [need] = notified(plan);
    expect(need).toMatchObject({
      cause: "followup-failed",
      reason: expect.stringContaining(
        "its result again unwritten on this host after the tick ran it again once",
      ),
    });
    expect(need?.evidence.question).toBeUndefined();
    expect(plan.wanted).toEqual([]);
  });

  it("that died again raises a need and is not run again", () => {
    const plan = planned(merged([marker(RERUN)]), [
      { record: followup(FIRST), state: DIED, result: null },
      { record: rerun(), state: DIED, result: null },
    ]);
    expect(plan.running).toEqual([]);
    expect(notified(plan)).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining(
          "dying again after the tick ran it again once",
        ),
      }),
    ]);
  });

  it("of a death is not run again for a write failure", () => {
    const plan = planned(merged([marker(RERUN)]), [
      { record: followup(FIRST), state: DIED, result: null },
      unwritten(rerun()),
    ]);
    expect(plan.running).toEqual([]);
    expect(notified(plan)).toEqual([
      expect.objectContaining({ cause: "followup-failed" }),
    ]);
  });
});

describe("failures.rerun_died: 0", () => {
  it("runs nothing again: a death and an unwritten result are failed follow-ups", () => {
    const off = { rerunDied: 0 };
    for (const ended of [
      { record: followup(FIRST, off), state: DIED, result: null },
      unwritten(followup(FIRST, off)),
    ] satisfies ReadRecord[]) {
      const plan = planned(merged([marker(FIRST)]), [ended]);
      expect(plan.running).toEqual([]);
      expect(notified(plan)).toEqual([
        expect.objectContaining({ cause: "followup-failed" }),
      ]);
      expect(
        planned(merged([]), [ended], { retried: new Set([FIRST]) }).wanted,
      ).toEqual([expect.not.objectContaining({ facts: expect.anything() })]);
    }
  });

  it("is read from the machine file, 1 by default, and refuses any other bound", () => {
    const read = (failures: string) =>
      parseMachineConfigText(failures, "/home/me/.jig/dispatch.yaml");
    const off = read("failures:\n  rerun_died: 0\n");
    expect(off.ok && off.value.failures?.rerunDied).toBe(0);
    const unset = read("failures:\n  notify_after: 3\n");
    expect(unset.ok && unset.value.failures?.rerunDied).toBe(1);
    const two = read("failures:\n  rerun_died: 2\n");
    expect(two.ok ? null : two.failure.reason).toContain(
      "failures.rerun_died must be 0 or 1",
    );
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** The records whose marker settlement releases, with the gate `rerunsHeld`. */
async function released(
  records: ReadRecord[],
  rerunsHeld: string | null,
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "jig-host-fault-"));
  roots.push(root);
  const ids: string[] = [];
  await settleRetryableFollowups(
    {
      records: {} as SharedRecords,
      slug: SLUG,
      host: "host-a",
      root,
      rerunsHeld,
    },
    records,
    isoFromMs(NOW),
    undefined,
    async (_ctx, record) => {
      ids.push(record.record.id);
      return [];
    },
  );
  return ids;
}

describe("the settlement that releases a marker", () => {
  it("releases an unwritten result's marker while the host's health check passes, and not while it fails", async () => {
    const records = [unwritten(followup(FIRST))];
    expect(await released(records, null)).toEqual([FIRST]);
    expect(await released(records, HELD)).toEqual([]);
  });
});
