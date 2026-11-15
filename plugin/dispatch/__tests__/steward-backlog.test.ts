/**
 * The steward starts on the judgment backlog alone: an empty backlog, or one
 * an earlier pass already saw, starts nothing whatever else the line did; a
 * new member starts a pass at once, within the host's hourly budget; and a
 * need that arrives framed is neither a member nor a target for a `need`.
 */
import { DEFAULT_PARK_CLASSES } from "../../shared/autonomy.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySteward, startKept } from "../lib/actions/steward.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { StationContext } from "../lib/line-station.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import {
  forgetStewardRun,
  keepStewardRun,
  recordBelongsToDigest,
  type StewardDigest,
} from "../lib/steward.ts";
import {
  type BacklogInput,
  judgedMembers,
  stewardBacklog,
  stewardTrigger,
} from "../lib/steward-backlog.ts";
import type { Action, LaunchOutcome } from "../lib/types.ts";

const REPO = "example-org/backlog";
const STATION: StationContext = {
  slug: REPO,
  carriedBy: () => null,
  itemsOnForge: true,
};

function stalled(key: string, idleSince: string): Action {
  return {
    stage: "notify",
    target: key,
    record: "tracker",
    reason: "stalled pickup",
    evidence: { state: "In Progress", idleSince },
    cause: "stalled",
  };
}

/** A pickup that ended on a question it framed: the tick frames the need. */
function pickupQuestion(key: string): Action {
  return {
    stage: "notify",
    target: key,
    record: "runtime",
    reason: "the pickup asks",
    evidence: { record: "launch-q", question: "Which scope?" },
    cause: "pickup-question",
  };
}

/** A cause the tick frames no decision for. */
function doubleClaim(key: string): Action {
  return {
    stage: "notify",
    target: key,
    record: "runtime",
    reason: "two sessions claim it",
    evidence: {},
    cause: "double-claim",
  };
}

/** A pickup pass that ended without a question: nothing a resume continues. */
function endedPass(id: string, item: string): ReadRecord {
  return {
    record: { id, repo: REPO, action: "pickup", item, workspace: null },
    state: {
      kind: "ended",
      exit: { at: new Date().toISOString(), code: 0, signal: null },
    },
    result: "done",
  } as unknown as ReadRecord;
}

function input(actions: Action[]): BacklogInput {
  return {
    slug: REPO,
    actions,
    running: [],
    drives: [],
    held: new Set(),
    queue: [],
    records: [],
    parkClasses: DEFAULT_PARK_CLASSES,
    labels: {},
    station: STATION,
  };
}

function digest(repo: string, actions: Action[] = []): StewardDigest {
  const backlog = stewardBacklog({ ...input(actions), slug: repo });
  return {
    version: 1,
    repo,
    backlog: backlog.members,
    drives: [],
    needs: backlog.needs,
    framed: backlog.framed,
    queue: [],
    passes: [],
    failures: [],
    load: null,
  };
}

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "steward-backlog-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

type ApplyArgs = Parameters<typeof applySteward>;

function stateAt(root: string, records: ReadRecord[] = []): ApplyArgs[0] {
  return {
    root,
    records,
    machine: { steward: { enabled: true } },
  } as unknown as ApplyArgs[0];
}

function observation(actions: Action[]): ApplyArgs[1] {
  return {
    forge: { ok: true, drives: [] },
    held: new Set(),
    tracked: { pickups: [] },
    opened: {
      owner: true,
      stages: new Set(["steward"]),
      values: {},
      repo: { slug: REPO },
      report: { launches: [], records: [], actions, running: [] },
    },
  } as unknown as ApplyArgs[1];
}

/** Apply the steward, counting the digest reads: a read is a pass the trigger let start. */
async function apply(
  root: string,
  actions: Action[],
  records: ReadRecord[] = [],
): Promise<{ reads: number; seen: ApplyArgs[1] }> {
  let reads = 0;
  const seen = observation(actions);
  await applySteward(stateAt(root, records), seen, STATION, async () => {
    reads++;
    return { ok: false, failure: { code: "unread", reason: "stopped here" } };
  });
  return { reads, seen };
}

/** Mark a kept run as submitted, as its pass's `steward submit` does. */
function submitted(id: string, root: string): void {
  stateDb(root)
    .query("UPDATE steward_runs SET submitted = 1 WHERE id = ?")
    .run(id);
}

describe("the steward's trigger", () => {
  const MINUTE = 60_000;

  test("an unchanged backlog and only newly ended passes start no pass, though the old cadence elapsed", async () => {
    const root = freshRoot();
    const actions = [stalled("#12", "2026-11-14T08:00:00Z")];
    keepStewardRun(
      "first",
      digest(REPO, actions),
      Date.now() - 45 * MINUTE,
      root,
    );
    submitted("first", root);
    const { reads, seen } = await apply(root, actions, [
      endedPass("pass-1", "#20"),
      endedPass("pass-2", "#21"),
    ]);
    expect(reads).toBe(0);
    expect(seen.opened.report.steward).toEqual({
      status: "every member of the judgment backlog (1) was already judged",
      trigger: "judged",
    });
  });

  test("an empty backlog starts no pass", async () => {
    const { reads, seen } = await apply(freshRoot(), []);
    expect(reads).toBe(0);
    expect(seen.opened.report.steward?.trigger).toBe("empty");
  });

  test("a stalled pickup newly in the backlog starts a pass at once, inside the old cadence, and the hourly budget refuses a fourth", async () => {
    const root = freshRoot();
    keepStewardRun("recent", digest(REPO), Date.now() - MINUTE, root);
    keepStewardRun(
      "other",
      digest("example-org/other"),
      Date.now() - MINUTE,
      root,
    );
    const first = await apply(root, [stalled("#12", "2026-11-14T08:00:00Z")]);
    expect(first.reads).toBe(1);
    // The third pass of the hour, as the started pass keeps its run.
    keepStewardRun(
      "third",
      digest(REPO, [stalled("#12", "2026-11-14T08:00:00Z")]),
      Date.now(),
      root,
    );
    const fourth = await apply(root, [
      stalled("#12", "2026-11-14T08:00:00Z"),
      stalled("#13", "2026-11-14T08:30:00Z"),
    ]);
    expect(fourth.reads).toBe(0);
    expect(fourth.seen.opened.report.steward).toEqual({
      status: "the host's hourly steward budget is spent",
      trigger: "budget",
    });
  });

  test("an uncached queued item missing a facet makes the backlog due", async () => {
    const root = freshRoot();
    let reads = 0;
    const seen = observation([]);
    (seen as unknown as { tracked: unknown }).tracked = {
      pickups: [{ key: "#40", title: "Task", state: "Todo" }],
      tracker: {
        poolIssue: async (key: string) => ({
          identifier: key,
          title: "Task",
          url: null,
          type: null,
          priority: null,
          size: null,
          state: { id: "todo", name: "Todo", type: "unstarted" },
          createdAt: "2026-01-01",
          assignee: { id: "a", name: "alex" },
          labels: [],
          isEpic: false,
          hasOpenChildren: false,
          truncated: [],
        }),
      },
    };
    await applySteward(stateAt(root), seen, STATION, async () => {
      reads++;
      return { ok: false, failure: { code: "unread", reason: "stopped here" } };
    });
    expect(reads).toBe(1);
  });

  test("a run taken back leaves its members unjudged", () => {
    const root = freshRoot();
    const seen = stalled("#12", "2026-11-14T08:00:00Z");
    keepStewardRun("reserved", digest(REPO, [seen]), Date.now(), root);
    forgetStewardRun("reserved", root);
    expect(judgedMembers(REPO, root).size).toBe(0);
  });

  test("a member is judged once any of the repository's passes saw it", () => {
    const root = freshRoot();
    const seen = stalled("#12", "2026-11-14T08:00:00Z");
    keepStewardRun("seen", digest(REPO, [seen]), Date.now(), root);
    submitted("seen", root);
    const judged = judgedMembers(REPO, root);
    const again = stewardBacklog(input([seen])).members;
    expect(stewardTrigger(again, judged)).toEqual({
      kind: "judged",
      members: 1,
    });
    const restalled = stewardBacklog(
      input([stalled("#12", "2026-11-14T09:00:00Z")]),
    ).members;
    expect(stewardTrigger(restalled, judged)).toEqual({
      kind: "due",
      members: 1,
      unjudged: 1,
    });
  });
});

describe("the judgment backlog's needs", () => {
  test("a need that already carries a framing is absent from the backlog and from the digest's needs", () => {
    const framed = pickupQuestion("#30");
    const unframed = doubleClaim("#31");
    const backlog = stewardBacklog(input([framed, unframed]));
    expect(backlog.members.map((m) => m.target)).toEqual(["#31"]);
    expect(backlog.needs.map((n) => n.target)).toEqual(["#31"]);
    expect(backlog.framed).toEqual([
      {
        target: "#30",
        cause: "pickup-question",
        framedBy: "dispatcher",
        question: expect.any(String),
      },
    ]);
    const kept = digest(REPO, [framed, unframed]);
    const need = (target: string) =>
      recordBelongsToDigest(
        { kind: "need", target, act: "Decide", ask: "Choose", reason: "r" },
        kept,
      );
    expect(need("#31")).toBe(true);
    expect(need("#30")).toBe(false);
  });

  test("a stalled pickup is a member the tick already frames, so no need record may reframe it", () => {
    const backlog = stewardBacklog(
      input([stalled("#12", "2026-11-14T08:00:00Z")]),
    );
    expect(backlog.members).toMatchObject([{ kind: "stalled", target: "#12" }]);
    expect(backlog.needs).toEqual([]);
    expect(backlog.framed).toMatchObject([
      { target: "#12", framedBy: "dispatcher" },
    ]);
  });

  test("a stalled pickup with a running session is not a member", () => {
    const backlog = stewardBacklog({
      ...input([stalled("#12", "2026-11-14T08:00:00Z")]),
      running: [
        { target: "#12", stage: "pickup", reason: "running", evidence: {} },
      ],
    });
    expect(backlog.members).toEqual([]);
  });
});

describe("a launch that starts no pass", () => {
  const SEEN = stalled("#12", "2026-11-14T08:00:00Z");
  const launchRecord = { id: "run-1", repo: REPO } as never;
  const refusal: LaunchOutcome = {
    target: "the steward",
    action: "steward",
    outcome: "failed",
    account: null,
    record: "run-1",
    detail: "the runtime started nothing",
  };

  test("a definitive refusal that removes the record takes the run back, so the backlog stays unjudged and due", async () => {
    const root = freshRoot();
    const state = stateAt(root);
    const launch = await startKept(
      state,
      launchRecord,
      {} as never,
      digest(REPO, [SEEN]),
      async () => refusal,
    );
    expect(launch.outcome).toBe("failed");
    expect(judgedMembers(REPO, root).size).toBe(0);
    const again = stewardBacklog(input([SEEN])).members;
    expect(stewardTrigger(again, judgedMembers(REPO, root)).kind).toBe("due");
  });

  test("a launch that throws takes the run back too", async () => {
    const root = freshRoot();
    await expect(
      startKept(
        stateAt(root),
        launchRecord,
        {} as never,
        digest(REPO, [SEEN]),
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(judgedMembers(REPO, root).size).toBe(0);
  });

  test("a record that stays pending keeps the run reserved", async () => {
    const root = freshRoot();
    const state = stateAt(root);
    await startKept(
      state,
      launchRecord,
      {} as never,
      digest(REPO, [SEEN]),
      async (s) => {
        s.records.push({
          record: launchRecord,
          state: { kind: "pending" },
        } as never);
        return { ...refusal, outcome: "lost" };
      },
    );
    expect(judgedMembers(REPO, root, new Set(["run-1"])).size).toBe(1);
    expect(judgedMembers(REPO, root).size).toBe(0);
  });

  test("a resume refused for now stays unjudged", () => {
    const root = freshRoot();
    const resume = { kind: "resume" as const, target: "rec-1", facts: "" };
    keepStewardRun(
      "run-r",
      { ...digest(REPO, []), backlog: [resume] },
      Date.now(),
      root,
    );
    submitted("run-r", root);
    const db = stateDb(root);
    db.query(
      "INSERT INTO steward_records (run, repo, value, applied, effect) VALUES ('run-r', ?, ?, 1, 'refused-open')",
    ).run(REPO, JSON.stringify({ kind: "resume", record: "rec-1" }));
    expect(judgedMembers(REPO, root).size).toBe(0);
    db.query("UPDATE steward_records SET effect = 'launched'").run();
    expect(judgedMembers(REPO, root).size).toBe(1);
  });

  test("a pass that ended without submitting judged nothing", () => {
    const root = freshRoot();
    const seen = stalled("#12", "2026-11-14T08:00:00Z");
    keepStewardRun("silent", digest(REPO, [seen]), Date.now(), root);
    expect(judgedMembers(REPO, root).size).toBe(0);
  });
});
