import { expect, it } from "bun:test";
import assert from "node:assert/strict";
import { conn, gitHub, issueNode, type Call } from "./github-fixtures.ts";
import { GitHubApiError } from "../scripts/lib/tracker/github/transport.ts";

function batchAnswer(call: Call) {
  return Object.fromEntries(
    Object.keys(call.variables)
      .filter((key) => /^number\d+$/.test(key))
      .map((key) => {
        const i = key.slice(6);
        return [
          `i${i}`,
          {
            issue: issueNode({
              number: Number(call.variables[key]),
              repo: `${call.variables[`owner${i}`]}/${call.variables[`name${i}`]}`,
              extra: { subIssues: conn([]) },
            }),
          },
        ];
      }),
  );
}

it("reads missing native keys in bounded chunks, sharing aliases and preserving repositories", async () => {
  const { t, calls } = gitHub(batchAnswer);
  const source = t.dispatchSource;
  assert(source?.issues);
  const keys = Array.from({ length: 43 }, (_, i) => `#${i + 1}`);
  keys.push("#1", "1", "ACME/APP#1", "acme/other#1");
  const rows = await source.issues(keys);
  expect(calls).toHaveLength(3);
  expect(rows.size).toBe(47 - 1);
  expect(rows.get("ACME/APP#1")?.identifier).toBe("#1");
  expect(rows.get("acme/other#1")?.identifier).toBe("acme/other#1");
  expect(
    calls.map(
      (call) =>
        Object.keys(call.variables).filter((key) => /^number/.test(key)).length,
    ),
  ).toEqual([20, 20, 4]);
  for (const call of calls) {
    expect(call.op).toBe("TrackerDispatchIssues");
    expect(call.query).toContain("labels(first: 100)");
    expect(call.query).toContain("subIssues(first: 100)");
    expect(call.query).not.toContain(
      "subIssues(first: 100) { nodes { subIssues",
    );
  }
});

it("rejects an inaccessible batch member or partial answer without publishing a partial map", async () => {
  for (const value of [null, {}, { i0: { issue: null } }]) {
    const { t, calls } = gitHub(() => value);
    assert(t.dispatchSource?.issues);
    await expect(t.dispatchSource.issues(["#1", "#2"])).rejects.toThrow();
    expect(calls).toHaveLength(1);
  }
});

it("shrinks batches for a wide native-store union and bounds even a single issue's selected objects", async () => {
  const { t, calls } = gitHub(batchAnswer);
  const source = t.dispatchSource;
  assert(source?.issues && source.configure);
  source.configure([
    "issue-type",
    "issue-fields",
    ...Array.from({ length: 100 }, (_, i) => `board:Status ${i}`),
  ]);
  await source.issues(Array.from({ length: 9 }, (_, i) => `#${i + 1}`));
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    const issues = Object.keys(call.variables).filter((key) =>
      /^number/.test(key),
    ).length;
    expect(issues).toBeLessThanOrEqual(4);
    expect(call.query).toContain("projectItems(first: 20)");
    expect(call.query).toContain("issueFieldValues(first: 25)");
    expect(call.query).toContain("rateLimit { cost remaining resetAt limit }");
  }
  source.configure(Array.from({ length: 501 }, (_, i) => `board:Status ${i}`));
  await expect(source.issues(["#1"])).rejects.toMatchObject({
    code: "too-costly",
  });
  expect(calls).toHaveLength(3);
});

it("propagates transient and budget failures and refuses expired batches before sending", async () => {
  for (const code of ["unreachable", "rate-limited"] as const) {
    const error = new GitHubApiError("unavailable", { code });
    const { t, calls } = gitHub((call, index) =>
      index === 1 ? error : batchAnswer(call),
    );
    assert(t.dispatchSource?.issues);
    await expect(
      t.dispatchSource.issues(
        Array.from({ length: 43 }, (_, i) => `#${i + 1}`),
      ),
    ).rejects.toBe(error);
    expect(calls).toHaveLength(2);
    await expect(
      t.dispatchSource.issues(["#3"], { deadline: 0 }),
    ).rejects.toThrow("deadline");
    expect(calls).toHaveLength(2);
  }
});

const since = "2026-01-01T00:00:00Z";
const updatedAt = "2026-01-02T00:00:00Z";
function change(
  number: number,
  assignee: string | null = null,
  parent: number | null = null,
) {
  return {
    number,
    updatedAt,
    state: "OPEN",
    stateReason: null,
    labels: conn([]),
    assignees: conn(assignee === null ? [] : [{ login: assignee }]),
    parent:
      parent === null
        ? null
        : { number: parent, repository: { nameWithOwner: "acme/app" } },
  };
}

it("probes assignment additions/removals, state and dependency updates and a child without a parent update", async () => {
  const { t, calls } = gitHub(() => ({
    repository: {
      issues: conn([
        change(1),
        change(2),
        change(3),
        change(4, "dana"),
        change(5, null, 6),
        change(7, "other"),
        change(8, "alex"),
      ]),
    },
  }));
  assert(t.changedSince);
  const answer = await t.changedSince({
    since,
    identity: "dana",
    identities: ["dana", "alex"],
    keys: ["#1", "#2", "#3", "#6"],
  });
  expect(new Set(answer.keys)).toEqual(
    new Set(["#1", "#2", "#3", "#4", "#5", "#6", "#8"]),
  );
  expect(answer.complete).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.query).toContain("filterBy: {since: $since}");
  expect(calls[0]?.query).toContain("issues(first: 100");
  expect(calls[0]?.query).toContain("labels(first: 20)");
  expect(calls[0]?.query).not.toContain("states:");
  expect(calls[0]?.query).not.toContain("body");
  expect(
    (
      await t.changedSince({
        since: "2026-01-02T00:00:00.000Z",
        identity: "dana",
        keys: ["#1"],
      })
    ).keys,
  ).toEqual([]);
});

it("keeps an unrelated update from refreshing the queue and probes foreign dependencies in their own repository", async () => {
  const { t, calls } = gitHub((call) => ({
    repository: {
      issues: conn(
        call.variables.name === "other" ? [change(9)] : [change(4, "other")],
      ),
    },
  }));
  assert(t.changedSince);
  const answer = await t.changedSince({
    since,
    identity: "dana",
    keys: ["#1", "Acme/Other#9"],
  });
  expect(answer.keys).toEqual(["Acme/Other#9"]);
  expect(answer.complete).toBe(true);
  // Keep the forge's timestamp as the next boundary. A local wall clock may
  // be ahead of GitHub and would hide a mutation that follows this probe.
  expect(answer.latest).toBe(updatedAt);
  expect(calls.map((call) => call.variables.name)).toEqual(["app", "other"]);
});

it("never reports incomplete probe pages or unreadable assignments as unchanged complete", async () => {
  for (const issues of [
    conn([], "more"),
    conn([{ ...change(9), assignees: conn([], "more") }]),
    conn([{ ...change(9), labels: conn([], "more") }]),
  ]) {
    const { t } = gitHub(() => ({ repository: { issues } }));
    assert(t.changedSince);
    expect(
      (await t.changedSince({ since, identity: "dana", keys: [] })).complete,
    ).toBe(false);
  }
});

it("keeps repository watermarks independent across interleaved updates without using the host clock", async () => {
  let phase = 0;
  const early = "2026-01-02T00:00:00Z";
  const missed = "2026-01-02T00:01:00Z";
  const later = "2026-01-02T00:02:00Z";
  const { t, calls } = gitHub((call) => ({
    repository: {
      issues: conn(
        call.variables.name === "app"
          ? [
              {
                ...change(phase === 0 ? 1 : 2),
                updatedAt: phase === 0 ? early : missed,
              },
            ]
          : [{ ...change(9), updatedAt: later }],
      ),
    },
  }));
  assert(t.changedSince);
  const query = { since, identity: "dana", keys: ["#1", "#2", "acme/other#9"] };
  const first = await t.changedSince(query);
  assert(first.watermarks);
  expect(first.watermarks).toEqual({ "acme/app": early, "acme/other": later });
  phase = 1;
  const next = await t.changedSince({
    ...query,
    since: first.latest ?? since,
    watermarks: first.watermarks,
  });
  expect(next.keys).toEqual(["#2"]);
  assert(next.watermarks);
  expect(calls.slice(2).map((call) => call.variables.since)).toEqual([
    early,
    later,
  ]);
  const quiet = await t.changedSince({
    ...query,
    since: next.latest ?? since,
    watermarks: next.watermarks,
  });
  expect(quiet.keys).toEqual([]);
  expect(quiet.complete).toBe(true);
});

it("retains inclusive watermark boundaries so a later same-timestamp row is observed", async () => {
  let phase = 0;
  const boundary = "2026-01-02T00:00:00Z";
  const { t } = gitHub(() => ({
    repository: {
      issues: conn([
        { ...change(1), updatedAt: boundary },
        ...(phase === 0 ? [] : [{ ...change(2), updatedAt: boundary }]),
      ]),
    },
  }));
  assert(t.changedSince);
  const first = await t.changedSince({
    since,
    identity: "dana",
    keys: ["#1", "#2"],
  });
  expect(first.keys).toEqual(["#1"]);
  const observed = first.boundaryRows?.["acme/app"];
  assert(observed);
  expect(observed).toHaveLength(1);
  phase = 1;
  const second = await t.changedSince({
    since: first.latest ?? since,
    ...(first.watermarks === undefined ? {} : { watermarks: first.watermarks }),
    ...(first.boundaryRows === undefined
      ? {}
      : { boundaryRows: first.boundaryRows }),
    identity: "dana",
    keys: ["#1", "#2"],
  });
  expect(second.keys).toEqual(["#2"]);
  expect(second.boundaryRows?.["acme/app"]).toHaveLength(2);
  expect(second.boundaryRows?.["acme/app"]).toEqual(
    expect.arrayContaining(observed),
  );
});

it.each(["assignment", "state", "labels", "parent"] as const)(
  "detects a changed %s on an already observed row at the same timestamp",
  async (kind) => {
    let after = false;
    const { t } = gitHub(() => ({
      repository: {
        issues: conn([
          {
            ...change(
              1,
              kind === "assignment" ? (after ? "dana" : "other") : null,
              kind === "parent" && after ? 9 : null,
            ),
            state: kind === "state" && after ? "CLOSED" : "OPEN",
            stateReason: kind === "state" && after ? "COMPLETED" : null,
            labels: conn([
              { name: kind === "labels" && after ? "In Progress" : "Todo" },
            ]),
          },
        ]),
      },
    }));
    assert(t.changedSince);
    const keys = kind === "assignment" ? [] : ["#1", "#9"];
    const first = await t.changedSince({ since, identity: "dana", keys });
    after = true;
    const second = await t.changedSince({
      since: first.latest ?? since,
      ...(first.watermarks ? { watermarks: first.watermarks } : {}),
      ...(first.boundaryRows ? { boundaryRows: first.boundaryRows } : {}),
      identity: "dana",
      keys,
    });
    expect(second.keys).toEqual(kind === "parent" ? ["#1", "#9"] : ["#1"]);
    after = false;
    const reverted = await t.changedSince({
      since: second.latest ?? since,
      ...(second.watermarks ? { watermarks: second.watermarks } : {}),
      ...(second.boundaryRows ? { boundaryRows: second.boundaryRows } : {}),
      identity: "dana",
      keys: ["#1", "#9"],
    });
    expect(reverted.keys).toEqual(["#1"]);
  },
);
