import { expect, it } from "bun:test";
import assert from "node:assert/strict";
import {
  conn,
  gitHub,
  issueNode,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { GitHubApiError } from "../../skills/do-item/scripts/lib/tracker/github/transport.ts";
import { sharedView } from "../lib/sources/served-reads.ts";
import { freshServedPickup } from "../lib/sources/served.ts";
import { metadata } from "../lib/sources/served-metadata.ts";
import {
  servedParentHold,
  servedParentSteps,
} from "../lib/sources/served-parents.ts";
import { isoFromMs } from "../../shared/time.ts";
import { isRecord } from "../../shared/guards.ts";

const START = 1_767_398_400_000;
const node = (number: number, assignee: string | null = "dana", extra = {}) =>
  issueNode({
    number,
    assignee,
    labels: ["Todo"],
    extra: { subIssues: conn([]), ...extra },
  });

/** The tracker with its assignment reads answered by `actor`, write access always granted. */
function assignedBy<T extends { dispatchSource?: object }>(
  tracker: T,
  actor: () => { id: string; name: string },
): T {
  return {
    ...tracker,
    dispatchSource: {
      ...tracker.dispatchSource,
      assignmentActor: async () => actor(),
      writeAccess: async () => true,
    },
  };
}

function fixture(legacy = false) {
  const values = new Map<string, unknown>();
  const cache = {
    get: <T>(key: string) => (values.get(key) as T) ?? null,
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
  let rows = [node(1)];
  let children = [node(2, null)];
  let changes: unknown = conn([]);
  let failure: Error | null = null;
  const fake = gitHub(
    (call) => {
      if (failure !== null) return failure;
      if (call.op === "TrackerDispatchQueue")
        return {
          repository: {
            issues: conn(
              rows.filter((row) =>
                (row.assignees as { nodes: { login: string }[] }).nodes.some(
                  (person) => person.login === call.variables.identity,
                ),
              ),
            ),
          },
        };
      if (call.op === "TrackerDispatchChanges")
        return {
          repository: {
            issues:
              isRecord(changes) && Array.isArray(changes.nodes)
                ? {
                    ...changes,
                    nodes: changes.nodes.map((value) =>
                      isRecord(value)
                        ? {
                            state: "OPEN",
                            stateReason: null,
                            labels: conn([]),
                            ...value,
                          }
                        : value,
                    ),
                  }
                : changes,
          },
        };
      if (call.op === "TrackerDispatchChildren")
        return { repository: { issue: { subIssues: conn(children) } } };
      if (call.op === "TrackerDispatchIssue" || call.op === "TrackerIssue")
        return {
          repository: {
            issue: {
              ...(rows.find((row) => row.number === call.variables.number) ??
                node(Number(call.variables.number), null)),
              ...(call.op === "TrackerIssue"
                ? { subIssues: conn(children) }
                : {}),
            },
          },
        };
      if (call.op === "TrackerDispatchIssues")
        return Object.fromEntries(
          Object.keys(call.variables)
            .filter((key) => /^number\d+$/.test(key))
            .map((key) => [
              `i${key.slice(6)}`,
              { issue: node(Number(call.variables[key]), null) },
            ]),
        );
      throw new Error(`unexpected operation ${call.op}`);
    },
    {
      taxonomy: { types: ["feature"], sizes: ["small"] },
      issue_tracker: {
        facets: {
          type: { store: "label" },
          size: { store: "label" },
          priority: { store: "label" },
        },
      },
    },
  );
  assert(fake.t.dispatchSource);
  const source = {
    ...fake.t.dispatchSource,
    credential: async () => "test-credential",
  };
  if (legacy) delete source.issues;
  const tracker = { ...fake.t, dispatchSource: source };
  const open = (minute: number) =>
    sharedView(
      new Map(),
      tracker,
      "dana",
      { nowMs: START + minute * 60_000, headroom: true },
      cache,
    );
  return {
    ...fake,
    tracker,
    cache,
    open,
    setChildren: (next: typeof children) => {
      children = next;
    },
    setRows: (next: typeof rows) => {
      rows = next;
    },
    setChanges: (next: unknown) => {
      changes = next;
    },
    fail: (error: Error | null) => {
      failure = error;
    },
  };
}

it("counts controlled per-key versus batched cold reads and one unchanged probe, separately from quota charges", async () => {
  const counts: number[] = [];
  for (const legacy of [true, false]) {
    const f = fixture(legacy);
    const view = await f.open(0);
    const before = f.calls.length;
    await Promise.all(
      Array.from({ length: 98 }, (_, i) => view.pool(`#${i + 2}`)),
    );
    counts.push(f.calls.length - before);
    view.save();
    const mark = f.calls.length;
    const quiet = await f.open(1);
    expect(quiet.source).toBe("unchanged");
    await quiet.pool("#50");
    expect(f.calls.slice(mark).map((call) => call.op)).toEqual([
      "TrackerDispatchChanges",
    ]);
    expect(quiet.readAt).toBe(START);
  }
  expect(counts).toEqual([98, 5]);
  console.log(
    JSON.stringify({
      controlledMissingKeys: 98,
      beforeRequests: counts[0],
      afterRequests: counts[1],
      unchangedProbeRequests: 1,
      measuredPoints: null,
      estimatedMinimumPoints: counts,
      fleetSavings: "not measured",
    }),
  );
});

it("bounds cached child membership and relations even when GitHub does not update the parent timestamp", async () => {
  const f = fixture();
  f.setRows([
    {
      ...node(1),
      labels: conn([{ name: "Todo" }, { name: "epic" }]),
      subIssues: conn([{ state: "OPEN" }]),
    },
  ]);
  let relations = [{ type: "blocked_by" as const, issue: "#9" }];
  const tracker = assignedBy(
    { ...f.tracker, listRelations: async () => relations },
    () => ({ id: "writer", name: "writer" }),
  );
  const first = await f.open(0);
  const initial = first.open()[0]?.issue;
  assert(initial);
  expect(
    (
      await metadata(tracker, initial, "dana", f.cache, null, first)
    ).children.map((child) => child.identifier),
  ).toEqual(["#2"]);
  first.save();
  const mark = f.calls.length;
  const quiet = await f.open(1);
  const quietParent = quiet.open()[0]?.issue;
  assert(quietParent);
  await metadata(tracker, quietParent, "dana", f.cache, null, quiet);
  expect(f.calls.slice(mark).map((call) => call.op)).toEqual([
    "TrackerDispatchChanges",
  ]);
  relations = [];
  f.setChildren([node(3, null)]);
  const next = await f.open(15);
  const parent = next.open()[0]?.issue;
  assert(parent);
  expect(parent.updatedAt).toBe(initial.updatedAt);
  const refreshed = await metadata(
    tracker,
    parent,
    "dana",
    f.cache,
    null,
    next,
  );
  expect(refreshed.children.map((child) => child.identifier)).toEqual(["#3"]);
  expect(refreshed.relations).toEqual([]);
});

it("rechecks cached GitHub ancestry on a full reading with the same issue timestamp", async () => {
  const f = fixture();
  const first = await f.open(0);
  const initial = first.open()[0]?.issue;
  assert(initial);
  const older = {
    readAt: first.readAt,
    metadataEpoch: (key: string) => first.metadataEpoch?.(key) ?? first.readAt,
    pool: (key: string) => first.pool(key),
  };
  expect(
    await servedParentHold(f.tracker, initial, f.cache, undefined, older),
  ).toBeNull();
  first.save();
  f.setRows([
    node(1, "dana", {
      parent: {
        number: 9,
        title: "Parent",
        repository: { nameWithOwner: "acme/app" },
      },
    }),
    node(9, null),
  ]);
  const next = await f.open(15);
  const current = next.open()[0]?.issue;
  assert(current);
  expect(current.updatedAt).toBe(initial.updatedAt);
  expect(
    await servedParentHold(f.tracker, current, f.cache, undefined, next),
  ).toBeNull();
  // The full reading's own row names the new parent: no issue read is sent for it.
  expect(
    (await servedParentSteps(f.tracker, current, f.cache, next))?.map(
      (step) => step.parent.identifier,
    ),
  ).toEqual(["#9"]);
  expect(
    f.calls.filter(
      (call) => call.op === "TrackerIssue" && call.variables.number === 1,
    ),
  ).toHaveLength(1);
  // Reads that hold no native row keep their own reading of the ancestry.
  expect(
    await servedParentHold(f.tracker, initial, f.cache, undefined, older),
  ).toBeNull();
  expect(
    f.calls.filter(
      (call) => call.op === "TrackerIssue" && call.variables.number === 1,
    ),
  ).toHaveLength(1);
});

it("refreshes metadata only for changed keys between full readings and keeps those versions on unchanged ticks", async () => {
  const f = fixture();
  f.setRows([node(1), node(2)]);
  let histories = 0;
  const tracker = assignedBy(
    { ...f.tracker, listRelations: async () => [] },
    () => {
      histories++;
      return { id: "writer", name: "writer" };
    },
  );
  const read = async (minute: number) => {
    const view = await f.open(minute);
    for (const held of view.open())
      await metadata(tracker, held.issue, "dana", f.cache, null, view);
    view.save();
    return view;
  };
  await read(0);
  expect(histories).toBe(2);
  f.setRows([
    node(1, "dana", { updatedAt: isoFromMs(START + 60_000) }),
    node(2),
  ]);
  f.setChanges(
    conn([
      {
        number: 1,
        updatedAt: isoFromMs(START + 60_000),
        assignees: conn([{ login: "dana" }]),
        parent: null,
      },
    ]),
  );
  expect((await read(1)).source).toBe("changed");
  expect(histories).toBe(3);
  expect((await read(2)).source).toBe("unchanged");
  expect(histories).toBe(3);
  // A full reading re-reads what GitHub does not timestamp; who made an
  // assignment is not among it, since an assignment changes the update time.
  expect((await read(15)).source).toBe("full");
  expect(histories).toBe(3);
});

it("refreshes an incomplete empty probe and a timestamp-invisible membership edit by the full-refresh deadline", async () => {
  const f = fixture();
  const first = await f.open(0);
  first.save();
  f.setRows([node(1), node(2)]);
  f.setChanges(conn([], "next"));
  const incomplete = await f.open(1);
  expect(incomplete.source).toBe("full");
  expect(incomplete.open().map((held) => held.issue.identifier)).toEqual([
    "#1",
    "#2",
  ]);
  incomplete.save();
  f.setChanges(conn([]));
  f.setRows([
    node(1, "dana", { subIssues: conn([{ state: "OPEN" }]) }),
    node(2),
  ]);
  const quiet = await f.open(2);
  expect(quiet.open()[0]?.issue.hasOpenChildren).toBe(false);
  quiet.save();
  const full = await f.open(16);
  expect(full.source).toBe("full");
  expect(full.open()[0]?.issue.hasOpenChildren).toBe(true);
});

it("refreshes assignments and states, invalidates dependent rows and discovers a child without a parent timestamp change", async () => {
  const f = fixture();
  const first = await f.open(0);
  await first.pool("#9");
  first.save();
  const changes = (
    number: number,
    assignee: string | null,
    parent: number | null = null,
  ) => ({
    number,
    updatedAt: isoFromMs(START + 60_000),
    assignees: conn(assignee === null ? [] : [{ login: assignee }]),
    parent:
      parent === null
        ? null
        : { number: parent, repository: { nameWithOwner: "acme/app" } },
  });
  f.setRows([node(2), { ...node(3), labels: conn([{ name: "In Progress" }]) }]);
  f.setChanges(
    conn([
      changes(1, null),
      changes(2, "dana"),
      changes(3, "dana"),
      changes(9, null),
      changes(4, null, 1),
    ]),
  );
  const mark = f.calls.length;
  const next = await f.open(1);
  expect(next.source).toBe("changed");
  expect(next.open().map((held) => held.issue.identifier)).toEqual(["#2"]);
  expect(next.progress().map((row) => row.identifier)).toEqual(["#3"]);
  await next.pool("#9");
  expect(f.calls.slice(mark).map((call) => call.op)).toEqual([
    "TrackerDispatchChanges",
    "TrackerDispatchQueue",
    "TrackerDispatchIssues",
  ]);
  next.save();
  const afterChange = f.calls.length;
  const quiet = await f.open(2);
  expect(quiet.source).toBe("unchanged");
  expect(f.calls.slice(afterChange).map((call) => call.op)).toEqual([
    "TrackerDispatchChanges",
  ]);
});

it("keeps the reading age on transient, inaccessible and budget failures and requires fresh launch authority", async () => {
  for (const code of ["unreachable", "not-found", "rate-limited"] as const) {
    const f = fixture();
    (await f.open(0)).save();
    f.fail(
      new GitHubApiError("probe failed", { code, until: START + 600_000 }),
    );
    const view = await f.open(1);
    expect(view.source).toBe("offline");
    expect(view.readAt).toBe(START);
    expect(view.limited !== null || view.unavailable !== undefined).toBe(true);
    const mark = f.calls.length;
    await expect(view.pool("#99")).rejects.toThrow();
    expect(f.calls).toHaveLength(mark);
    expect(await freshServedPickup(f.tracker, "#1", "dana")).toContain(
      "cannot be read again",
    );
  }
  const f = fixture();
  (await f.open(0)).save();
  const kept = await f.open(1);
  expect(kept.open()).toHaveLength(1);
  f.setRows([{ ...node(1), state: "CLOSED", stateReason: "COMPLETED" }]);
  expect(await freshServedPickup(f.tracker, "#1", "dana")).toContain(
    "no longer open",
  );
});

it("refreshes former-parent membership after a child moves without rereading unrelated assignment history", async () => {
  const f = fixture();
  f.setRows([
    {
      ...node(1),
      labels: conn([{ name: "Todo" }, { name: "epic" }]),
      subIssues: conn([{ state: "OPEN" }]),
    },
  ]);
  let histories = 0;
  const tracker = assignedBy(
    { ...f.tracker, listRelations: async () => [] },
    () => {
      histories++;
      return { id: "writer", name: "writer" };
    },
  );
  const first = await f.open(0);
  const parent = first.open()[0]?.issue;
  assert(parent);
  expect(
    (
      await metadata(tracker, parent, "dana", f.cache, null, first)
    ).children.map((child) => child.identifier),
  ).toEqual(["#2"]);
  await first.pool("#2");
  first.save();
  f.setChildren([]);
  f.setChanges(
    conn([
      {
        number: 2,
        updatedAt: isoFromMs(START + 60_000),
        assignees: conn([]),
        parent: null,
      },
    ]),
  );
  const moved = await f.open(1);
  expect(moved.source).toBe("changed");
  const current = moved.open()[0]?.issue;
  assert(current);
  expect(current.updatedAt).toBe(parent.updatedAt);
  expect(
    (await metadata(tracker, current, "dana", f.cache, null, moved)).children,
  ).toEqual([]);
  expect(histories).toBe(1);
  moved.save();
  const mark = f.calls.length;
  const quiet = await f.open(2);
  await metadata(tracker, current, "dana", f.cache, null, quiet);
  expect(f.calls.slice(mark).map((call) => call.op)).toEqual([
    "TrackerDispatchChanges",
  ]);
});

it("persists source watermarks through changed and unchanged native queue readings", async () => {
  const f = fixture();
  const watermarks = {
    "acme/app": isoFromMs(START),
    "acme/other": isoFromMs(START + 30_000),
  };
  const queries: unknown[] = [];
  f.tracker.changedSince = async (query) => {
    queries.push(query.watermarks);
    return {
      keys: queries.length === 1 ? ["#1"] : [],
      complete: true,
      latest: isoFromMs(START),
      watermarks,
    };
  };
  (await f.open(0)).save();
  (await f.open(1)).save();
  (await f.open(2)).save();
  (await f.open(3)).save();
  expect(queries).toEqual([undefined, watermarks, watermarks]);
});

it("persists source boundary rows through native queue readings", async () => {
  const f = fixture();
  const boundaryRows = { "acme/app": ["#1"] };
  const queries: unknown[] = [];
  f.tracker.changedSince = async (query) => {
    queries.push(query.boundaryRows);
    return {
      keys: [],
      complete: true,
      latest: isoFromMs(START),
      boundaryRows,
    };
  };
  (await f.open(0)).save();
  (await f.open(1)).save();
  (await f.open(2)).save();
  expect(queries).toEqual([undefined, boundaryRows]);
});

it.each(["same", "later", "same instant"] as const)(
  "preserves an older person's boundary when another queue has a %s watermark",
  async (position) => {
    const f = fixture();
    const boundary = isoFromMs(START);
    const later = isoFromMs(START + 30_000);
    let olderBoundary: Readonly<Record<string, string[]>> | undefined;
    const nativeProbe = f.tracker.changedSince;
    assert(nativeProbe);
    f.tracker.changedSince = async (query, signal) => {
      const answer = await nativeProbe(query, signal);
      if (query.identity === "alex" && olderBoundary === undefined)
        olderBoundary = answer.boundaryRows;
      return answer;
    };
    const changed = (number: number, time = boundary) => ({
      number,
      updatedAt: time,
      assignees: conn([{ login: "alex" }]),
      parent: null,
    });
    const open = (person: string, minute: number, people = [person]) =>
      sharedView(
        new Map(),
        f.tracker,
        person,
        {
          nowMs: START + minute * 60_000,
          headroom: true,
          scopeIdentities: people,
        },
        f.cache,
      );
    f.setRows([node(1, "alex")]);
    (await open("alex", 0)).save();
    f.setChanges(
      conn([
        changed(
          1,
          position === "same instant"
            ? boundary.replace(".000Z", "Z")
            : boundary,
        ),
      ]),
    );
    (await open("alex", 1)).save();
    (await open("sam", 0)).save();
    f.setChanges(
      conn([
        ...(position === "later" ? [changed(9, later)] : []),
        changed(1),
        changed(2),
      ]),
    );
    (await open("sam", 1)).save();
    f.setRows([node(1, "alex"), node(2, "alex")]);
    const original = f.tracker.changedSince;
    assert(original);
    const observed: unknown[] = [];
    f.tracker.changedSince = async (query, signal) => {
      observed.push(query.boundaryRows);
      return original(query, signal);
    };
    const refreshed = await open("alex", 2, ["alex", "sam"]);
    expect(refreshed.source).toBe("changed");
    expect(refreshed.open().map((held) => held.issue.identifier)).toEqual([
      "#1",
      "#2",
    ]);
    expect(observed).toEqual([olderBoundary]);
    refreshed.save();
    expect((await open("alex", 3)).source).toBe("unchanged");
  },
);
