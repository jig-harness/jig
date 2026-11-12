import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickupHold } from "../lib/actions/pickup-hold.ts";
import type {
  LaunchRecord,
  PickupRefusal,
  ReadRecord,
} from "../lib/launches.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import { pruneLaunches } from "../lib/launches.ts";
import { readRefusal } from "../lib/pickup-refusal.ts";
import { pickupPassArgv } from "../lib/session.ts";
import type { DispatchSection, WantedItem } from "../lib/types.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A checkout whose label taxonomy has the size group the batch's size store needs. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-refused-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "label-taxonomy.yaml"),
    `version: 1
types:
  - id: task
statuses:
  - id: todo
groups:
  - id: size
    required: true
    labels:
      - id: small
`,
  );
  return dir;
}

const BATCH = ["#1", "#2", "#3"];
const SEEN = "2026-01-02T00:00:00Z";
const LATER = "2026-02-01T00:00:00Z";

/** An ended served batch pickup of `BATCH` whose pass recorded `refusal`. */
function refusedBatch(refusal: PickupRefusal): ReadRecord {
  const record = {
    id: "2026-11-09T00-00-00-000Z-batch",
    action: "pickup",
    repo: "example-org/example-repo",
    item: "#1",
    servedPerson: "alex",
    batchItems: BATCH.map((key) => ({ key, person: "alex" })),
    createdAt: "2026-11-09T00:00:00.000Z",
    released: false,
  } as unknown as LaunchRecord;
  return {
    record,
    state: {
      kind: "ended",
      exit: { at: "2026-11-09T00:01:00Z", code: 0, signal: null },
      process: null,
    },
    result: "failed",
    refusal,
  };
}

function member(key: string, updatedAt: string, reason = `${key} is blocked`) {
  return { key, updatedAt, reason };
}

describe("a batch pickup the start rules refused one member of", () => {
  const read = refusedBatch({
    reason: "#2 is blocked",
    updatedAt: SEEN,
    members: [member("#2", SEEN)],
  });

  it("holds only the refused member, with its own reason", () => {
    const hold = pickupHold("#2", [read], SEEN);
    expect(hold.kind).toBe("refused");
    expect("why" in hold ? hold.why : "").toContain("#2 is blocked");
    expect(pickupHold("#1", [read], SEEN).kind).toBe("none");
    expect(pickupHold("#3", [read], SEEN).kind).toBe("none");
    // A member the rules did not refuse stays eligible even unread.
    expect(pickupHold("#3", [read]).kind).toBe("none");
  });

  it("releases the refused member once its own updatedAt moves", () => {
    expect(pickupHold("#2", [read], LATER).kind).toBe("none");
  });

  it("re-batches the rest without the refused member", () => {
    const wanted: WantedItem[] = BATCH.map((key) => ({
      key,
      title: "task",
      url: null,
      state: "Todo",
      assignee: "alex",
      assignedBy: "writer",
      servedPerson: "alex",
      updatedAt: SEEN,
      queueIssue: {
        identifier: key,
        title: "task",
        url: null,
        priority: 2,
        type: "task",
        size: "small",
        createdAt: "2026-01-01",
        state: { id: "s", name: "Todo", type: "unstarted" },
        assignee: { id: "a", name: "alex" },
        labels: ["area:tools"],
        isEpic: false,
        hasOpenChildren: false,
        truncated: [],
      },
    }));
    const plan = planPickups({
      slug: "example-org/example-repo",
      section: { stalledAfterMs: 3_600_000 } as DispatchSection,
      pickups: wanted,
      claimed: [],
      sessions: { ok: true, source: "test", workspaces: [] },
      launches: [read],
      idleSince: new Map(),
      nowMs: Date.parse("2026-11-10T00:00:00Z"),
      values: {
        do_item: { agents: { codearea_areas: { "area:tools": "tools" } } },
      },
      root: checkout(),
    });
    const pickups = plan.actions.filter((a) => a.stage === "pickup");
    expect(pickups).toHaveLength(1);
    expect(
      JSON.parse(String(pickups[0]?.evidence.batchItems)).map(
        (i: { key: string }) => i.key,
      ),
    ).toEqual(["#1", "#3"]);
    expect(plan.quiet).toContainEqual(
      expect.objectContaining({ target: "#2", class: "pickup-refused" }),
    );
  });
});

describe("a batch pickup the start rules refused two members of", () => {
  const read = refusedBatch({
    reason: "#1 is blocked",
    updatedAt: SEEN,
    members: [member("#1", SEEN), member("#3", LATER)],
  });

  it("releases each refused member on its own updatedAt", () => {
    expect(pickupHold("#1", [read], SEEN).kind).toBe("refused");
    expect(pickupHold("#3", [read], LATER).kind).toBe("refused");
    expect(pickupHold("#2", [read], SEEN).kind).toBe("none");
    // #1 changes; #3 has not moved past the time its own refusal saw.
    expect(pickupHold("#1", [read], LATER).kind).toBe("none");
    expect(pickupHold("#3", [read], LATER).kind).toBe("refused");
    expect(pickupHold("#3", [read], "2026-03-01T00:00:00Z").kind).toBe("none");
  });

  it("names each member's own reason", () => {
    const hold = pickupHold("#3", [read], LATER);
    expect("why" in hold ? hold.why : "").toContain("#3 is blocked");
  });
});

describe("a refusal recorded without a key", () => {
  const read = refusedBatch({ reason: "blocked", updatedAt: SEEN });

  it("holds every member on the one time, as before", () => {
    for (const key of BATCH)
      expect(pickupHold(key, [read], SEEN).kind).toBe("refused");
    expect(pickupHold("#2", [read], LATER).kind).toBe("none");
    expect(pickupHold("#1", [read]).kind).toBe("ended");
  });
});

describe("readRefusal", () => {
  it("reads a record without members as before", () => {
    expect(
      readRefusal(JSON.stringify({ reason: "why", updatedAt: SEEN })),
    ).toEqual({ reason: "why", updatedAt: SEEN });
  });

  it("reads each member's key, time and reason", () => {
    const refusal = {
      reason: "#2 is blocked",
      updatedAt: SEEN,
      members: [member("#2", SEEN)],
    };
    expect(readRefusal(JSON.stringify(refusal))).toEqual(refusal);
  });

  it("leaves a malformed member list unread", () => {
    for (const members of [
      "#2",
      [{ key: "#2", updatedAt: "not a time", reason: "r" }],
      [{ key: 2, updatedAt: SEEN, reason: "r" }],
      [],
      [{ key: "", updatedAt: SEEN, reason: "r" }],
      [{ key: "  ", updatedAt: SEEN, reason: "r" }],
      [member("#2", SEEN), member("#2", LATER)],
    ])
      expect(
        readRefusal(JSON.stringify({ reason: "r", updatedAt: SEEN, members })),
      ).toBeNull();
  });
});

describe("a batch re-batched without its refused member", () => {
  it("keeps the refusal's record past retention while it is the member's latest", () => {
    const original = refusedBatch({
      reason: "#2 is blocked",
      updatedAt: SEEN,
      members: [member("#2", SEEN)],
    });
    const rebatched = refusedBatch({
      reason: "#1 is blocked",
      updatedAt: SEEN,
      members: [member("#1", SEEN)],
    });
    rebatched.record = {
      ...rebatched.record,
      id: "2026-11-10T00-00-00-000Z-batch",
      createdAt: "2026-11-10T00:00:00.000Z",
      batchItems: [
        { key: "#1", person: "alex" },
        { key: "#3", person: "alex" },
      ],
    } as unknown as LaunchRecord;
    const pruned = pruneLaunches(
      [original, rebatched],
      Date.parse("2027-06-01"),
      30,
      checkout(),
    );
    expect(pruned).not.toContain(original.record.id);
  });
});

describe("a batch pass's prompt", () => {
  const record = {
    id: "2026-11-09T00-00-00-000Z-batch",
    token: "token",
    item: "#1",
    vendor: "claude",
    servedPerson: "alex",
  } as unknown as LaunchRecord;

  it("asks for the refused member's key beside its updatedAt", () => {
    const batch = pickupPassArgv(
      { ...record, batchItems: [{ key: "#1", person: "alex" }] },
      [],
    ).join(" ");
    expect(batch).toContain(
      '--refused <its updatedAt> --key <its issue> --reason "<its reason>"',
    );
  });

  it("keeps a single-item pickup's refusal line as it was", () => {
    const single = pickupPassArgv(record, []).join(" ");
    expect(single).toContain(
      '--refused <its updatedAt> --reason "<its reason>"',
    );
    expect(single).not.toContain("--key");
  });
});
