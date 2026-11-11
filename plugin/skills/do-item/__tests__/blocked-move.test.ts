/**
 * The `blocked` writer against an in-memory tracker: a tracker that names
 * the state, one that does not, and the round trip from a park to the
 * re-arm.
 */
import { describe, expect, test } from "bun:test";
import { type BlockedPr, projectBlocked } from "../scripts/lib/blocked-move.ts";
import type {
  BlockedFields,
  CanonicalState,
  CommentFact,
  Issue,
} from "../scripts/lib/tracker/port.ts";
import { DEFAULT_LABELS } from "../../../shared/pr-labels/projection.ts";

const LABELS = { ...DEFAULT_LABELS, enabled: true };
const KEYS = {
  source: "(?<!\\w)ENG-\\d+(?!\\w)",
  normalize: (k: string) => k.toUpperCase(),
};

const NAMES: Record<string, string | null> = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  pr_open: "In Review",
  blocked: "Blocked",
  in_review: "Accepted",
  ops_pending: "Ops Pending",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

interface Fake {
  states: Map<string, string>;
  comments: Map<string, CommentFact[]>;
  fields: Map<string, BlockedFields | null>;
  calls: string[];
  failComment?: boolean;
}

function fakeTracker(fake: Fake, names: Record<string, string | null>) {
  const type = (name: string) =>
    name === "Done" ? "completed" : name === "To Do" ? "unstarted" : "started";
  return {
    stateName: ((s: CanonicalState) => names[s] ?? null) as never,
    async getIssue(key: string) {
      const name = fake.states.get(key);
      fake.calls.push(`get ${key}`);
      return name === undefined
        ? null
        : ({ identifier: key, state: { name, type: type(name) } } as Issue);
    },
    async issueComments(key: string) {
      fake.calls.push(`comments ${key}`);
      return { uuid: key, comments: fake.comments.get(key) ?? [] };
    },
    async transition(key: string, state: CanonicalState) {
      fake.calls.push(`move ${key} ${state}`);
      fake.states.set(key, names[state] as string);
    },
    async postComment(key: string, body: string) {
      fake.calls.push(`comment ${key}`);
      if (fake.failComment === true) throw new Error("forbidden");
      fake.comments.set(key, [
        ...(fake.comments.get(key) ?? []),
        { body, createdAt: "2026-11-11T09:00:00Z", trusted: true },
      ]);
    },
    async writeBlockedFields(key: string, value: BlockedFields | null) {
      fake.calls.push(`fields ${key}`);
      fake.fields.set(key, value);
      return true;
    },
  };
}

const fresh = (states: Record<string, string>): Fake => ({
  states: new Map(Object.entries(states)),
  comments: new Map(),
  fields: new Map(),
  calls: [],
});

const parked = (over: Partial<BlockedPr> = {}): BlockedPr => ({
  pr: 7,
  url: "https://github.com/acme/app/pull/7",
  body: "Closes ENG-123",
  labels: ["jig:parked"],
  projected: { state: "parked" },
  stop: "2026-11-11T08:00:00Z",
  causes: [{ class: "human-decision", reason: "Run the backfill first?" }],
  ...over,
});

const NOW = () => new Date("2026-11-11T09:30:00Z");

describe("a tracker with a blocked state", () => {
  test("a park moves the linked item, comments with the class and the reason, and writes the fields", async () => {
    const fake = fresh({ "ENG-123": "In Progress" });
    const out = await projectBlocked(
      fakeTracker(fake, NAMES),
      KEYS,
      LABELS,
      parked(),
      NOW,
    );
    expect(out.map((o) => o.outcome)).toEqual(["blocked"]);
    expect(fake.states.get("ENG-123")).toBe("Blocked");
    const body = fake.comments.get("ENG-123")?.[0]?.body ?? "";
    expect(body).toContain("`human-decision`: Run the backfill first?");
    expect(body).toContain('"from":"in_progress"');
    expect(fake.fields.get("ENG-123")).toEqual({
      reason: "human-decision: Run the backfill first?",
      since: "2026-11-11T09:30:00.000Z",
    });
  });

  test("a ledger that is no longer the caller's moves nothing", async () => {
    const fake = fresh({ "ENG-123": "In Progress" });
    const out = await projectBlocked(
      fakeTracker(fake, NAMES),
      KEYS,
      LABELS,
      parked(),
      NOW,
      async () => false,
    );
    expect(out.map((o) => o.outcome)).toEqual(["refused"]);
    expect(fake.states.get("ENG-123")).toBe("In Progress");
  });

  test("the round trip: answering the park and re-arming returns the item to the state it left", async () => {
    const fake = fresh({ "ENG-123": "In Review" });
    const tracker = fakeTracker(fake, NAMES);
    await projectBlocked(tracker, KEYS, LABELS, parked(), NOW);
    expect(fake.states.get("ENG-123")).toBe("Blocked");
    const out = await projectBlocked(
      tracker,
      KEYS,
      LABELS,
      parked({
        labels: ["jig:driving"],
        projected: { state: "driving" },
        stop: "",
      }),
      NOW,
    );
    expect(out.map((o) => o.outcome)).toEqual(["returned"]);
    expect(fake.states.get("ENG-123")).toBe("In Review");
    expect(fake.fields.get("ENG-123")).toBeNull();
  });

  test("an item a person moved out of blocked during the same stop stays where they put it", async () => {
    const fake = fresh({ "ENG-123": "In Progress" });
    const tracker = fakeTracker(fake, NAMES);
    await projectBlocked(tracker, KEYS, LABELS, parked(), NOW);
    fake.states.set("ENG-123", "In Progress");
    const out = await projectBlocked(tracker, KEYS, LABELS, parked(), NOW);
    expect(out.map((o) => o.outcome)).toEqual(["kept"]);
    expect(fake.states.get("ENG-123")).toBe("In Progress");
  });

  test("an item already agreeing is read once and not written", async () => {
    const fake = fresh({ "ENG-123": "In Progress" });
    const out = await projectBlocked(
      fakeTracker(fake, NAMES),
      KEYS,
      LABELS,
      parked({ projected: { state: "driving" } }),
      NOW,
    );
    expect(out.map((o) => o.outcome)).toEqual(["kept"]);
    expect(fake.calls).toEqual(["get ENG-123"]);
  });

  test("a marker from an untrusted comment does not return an item", async () => {
    const fake = fresh({ "ENG-123": "Blocked" });
    fake.comments.set("ENG-123", [
      {
        body: '<!-- jig:blocked {"pr":7,"stop":"s","from":"todo"} -->',
        createdAt: "2026-11-11T09:00:00Z",
        trusted: false,
      },
    ]);
    const out = await projectBlocked(
      fakeTracker(fake, NAMES),
      KEYS,
      LABELS,
      parked({ projected: { state: "driving" } }),
      NOW,
    );
    expect(out.map((o) => o.outcome)).toEqual(["kept"]);
    expect(fake.states.get("ENG-123")).toBe("Blocked");
  });

  test("several linked items are each moved; a pull request that links none moves nothing", async () => {
    const fake = fresh({ "ENG-1": "In Progress", "ENG-2": "To Do" });
    const out = await projectBlocked(
      fakeTracker(fake, NAMES),
      KEYS,
      LABELS,
      parked({ body: "| Closes ENG-1 | a |\n| Closes eng-2 | b |" }),
      NOW,
    );
    expect(out.map((o) => [o.item, o.outcome])).toEqual([
      ["ENG-1", "blocked"],
      ["ENG-2", "blocked"],
    ]);
    const none = fresh({ "ENG-1": "In Progress" });
    expect(
      await projectBlocked(
        fakeTracker(none, NAMES),
        KEYS,
        LABELS,
        parked({ body: "Part of ENG-1" }),
        NOW,
      ),
    ).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  test("a pull request carrying hold or held is left, and nothing is read", async () => {
    for (const label of ["jig:hold", "jig:held"]) {
      const fake = fresh({ "ENG-123": "In Progress" });
      expect(
        await projectBlocked(
          fakeTracker(fake, NAMES),
          KEYS,
          LABELS,
          parked({ labels: [label] }),
          NOW,
        ),
      ).toEqual([]);
      expect(fake.calls).toEqual([]);
    }
  });

  test("a comment that does not post undoes the move", async () => {
    const fake = fresh({ "ENG-123": "In Progress" });
    fake.failComment = true;
    const out = await projectBlocked(
      fakeTracker(fake, NAMES),
      KEYS,
      LABELS,
      parked(),
      NOW,
    );
    expect(out[0]?.outcome).toBe("refused");
    expect(fake.states.get("ENG-123")).toBe("In Progress");
  });
});

test("a tracker without a blocked state reads and writes nothing", async () => {
  const fake = fresh({ "ENG-123": "In Progress" });
  expect(
    await projectBlocked(
      fakeTracker(fake, { ...NAMES, blocked: null }),
      KEYS,
      LABELS,
      parked(),
      NOW,
    ),
  ).toEqual([]);
  expect(fake.calls).toEqual([]);
  expect(fake.states.get("ENG-123")).toBe("In Progress");
});
