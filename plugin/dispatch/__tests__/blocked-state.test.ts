/**
 * dispatch and the optional `blocked` state: it is never a pickup, a served
 * walk never starts an item in it, and the tick's projection moves the
 * items each managed pull request links as its ledger says, only with
 * `--apply` and never on a pull request serialization holds.
 */
import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { IssueKeys } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { writeBlocked } from "../lib/actions/blocked.ts";
import { DEFAULT_LABELS } from "../lib/labels.ts";
import { dispatchSection } from "../lib/section.ts";
import { freshServedPickup, readServedPickups } from "../lib/sources/served.ts";
import type { DrivenPr } from "../lib/types.ts";
import { issue } from "./served-fixtures.ts";

describe("dispatch.states and blocked", () => {
  it("refuses blocked as a pickup state", () => {
    const read = dispatchSection({
      issue_tracker: { states: { blocked: "Blocked" } },
      dispatch: { identity: "factory", states: ["todo", "blocked"] },
    });
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.failure.reason).toContain(
        "dispatch.states cannot list blocked",
      );
  });
});

describe("a served walk and blocked", () => {
  // A team whose Blocked state sits in the unstarted category: its name still keeps it out.
  const blocked: PoolIssue = {
    ...issue("#2", [], null),
    state: { id: "b", name: "Blocked", type: "unstarted" },
  };
  const tracker = {
    adapter: "github",
    team: "example/repo",
    stateName: (s: string) =>
      s === "blocked" ? "Blocked" : s === "pr_open" ? null : s,
    assignedIssues: async (_: string, s: string[]) =>
      s.includes("in_progress") ? [] : [issue("#1", ["epic"])],
    assignedBy: async () => ({ id: "w", name: "writer", trusted: true }),
    openChildren: async () => [blocked, issue("#3", [], null)],
    listRelations: async () => [],
    poolIssue: async (k: string) =>
      [issue("#1", ["epic"]), blocked, issue("#3", [], null)].find(
        (i) => i.identifier === k,
      ) ?? null,
    getIssue: async (k: string) => ({
      identifier: k,
      description: "",
      parent: null,
    }),
  } as unknown as Tracker;

  it("never offers an item in blocked, whatever its category", async () => {
    const reading = await readServedPickups(
      tracker,
      [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }],
      { epic: "epic", nowMs: 1, headroom: true },
    );
    expect(reading.wanted.map((w) => w.key)).toEqual(["#3"]);
    expect(await freshServedPickup(tracker, "#2", "alex")).toBe(
      "the served item is no longer open and not started",
    );
  });
});

describe("the tick's blocked output", () => {
  const keys = {
    source: "(?<![\\w&#])#[1-9]\\d*(?!\\w)",
    normalize: (k: string) => k,
  } as IssueKeys;
  const tracker = {
    stateName: (s: string) => (s === "blocked" ? "Blocked" : s),
  } as unknown as Tracker;
  const drive = (number: number, over: Partial<DrivenPr> = {}): DrivenPr => ({
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    title: "t",
    head: "h",
    class: "parked",
    why: "stopped 5 (parked)",
    evidence: { started: "2026-11-11T08:00:00Z", round: 3, exit: 5 },
    waiting: [
      {
        key: "r1",
        kind: "thread",
        lines: [],
        decision: {
          class: "scope",
          call: { question: "Ship it without the export?" },
        } as never,
      },
    ],
    ...over,
  });
  const input = (drives: DrivenPr[], over = {}) => ({
    config: { ...DEFAULT_LABELS, enabled: true },
    tracker,
    keys,
    open: drives.map((d) => ({
      number: d.number,
      url: d.url,
      body: `Closes #${d.number + 100}`,
      labels: ["jig:parked"],
    })),
    read: new Set(drives.map((d) => d.number)),
    drives,
    merged: new Set<number>(),
    ...over,
  });
  const mode = { apply: true, late: () => null };

  it("projects each managed pull request with its stop and each park's class and reason", async () => {
    const seen: unknown[] = [];
    const out = await writeBlocked(
      input([drive(7)]),
      mode,
      async (_t, _k, _c, pr) => {
        seen.push(pr);
        return [
          {
            item: "#107",
            outcome: "blocked",
            detail: "#107 moved from In Progress to blocked",
          },
        ];
      },
    );
    expect(seen).toEqual([
      {
        pr: 7,
        url: "https://github.com/example/repo/pull/7",
        body: "Closes #107",
        labels: ["jig:parked"],
        projected: { state: "parked" },
        stop: "2026-11-11T08:00:00Z",
        causes: [{ class: "scope", reason: "Ship it without the export?" }],
      },
    ]);
    expect(out).toEqual([
      {
        target: "PR #7",
        item: "#107",
        outcome: "written",
        detail: "#107 moved from In Progress to blocked",
      },
    ]);
  });

  it("preserves a workflow-specific skipped projection in its receipt", async () => {
    const out = await writeBlocked(input([drive(7)]), mode, async () => [
      {
        item: "#107",
        outcome: "skipped",
        detail: "#107: blocked is absent from its workflow",
      },
    ]);
    expect(out).toEqual([
      {
        target: "PR #7",
        item: "#107",
        outcome: "skipped",
        detail: "#107: blocked is absent from its workflow",
      },
    ]);
  });

  it("reads nothing without --apply, without the state, or for a pull request serialization holds", async () => {
    let calls = 0;
    const project = async () => {
      calls++;
      return [];
    };
    await writeBlocked(input([drive(7)]), { ...mode, apply: false }, project);
    await writeBlocked(
      input([drive(7)], {
        tracker: { stateName: () => null } as unknown as Tracker,
      }),
      mode,
      project,
    );
    await writeBlocked(
      input([drive(7)], {
        serialized: { held: new Map([[7, {}]]), unplaced: new Map() },
      }),
      mode,
      project,
    );
    expect(calls).toBe(0);
  });

  it("waits when the ledger changed since the tick read it", async () => {
    const out = await writeBlocked(
      input([drive(7)]),
      { ...mode, current: async () => "its drive ledger changed" },
      async () => {
        throw new Error("no projection while the ledger moved");
      },
    );
    expect(out).toEqual([
      {
        target: "PR #7",
        item: null,
        outcome: "waits",
        detail: "its drive ledger changed",
      },
    ]);
  });
});
