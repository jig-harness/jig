/** Failed ready-pool calls use the same row accounting as factory reads. */
import { describe, expect, it } from "bun:test";
import { AssignerUnknown } from "../../skills/do-item/scripts/lib/tracker/assigner-unknown.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { TrackerRateLimited } from "../../shared/outbound/budget.ts";
import { OutboundError } from "../../shared/outbound/failure.ts";
import { currentMs } from "../../shared/time.ts";
import { dispatchSection } from "../lib/section.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { limitedRow } from "../lib/sources/served-failures.ts";

const item: PoolIssue = {
  identifier: "ENG-9",
  title: "ready",
  url: null,
  type: null,
  size: null,
  priority: 0,
  createdAt: "2026-09-01T00:00:00Z",
  state: { id: "s", name: "Todo", type: "unstarted" },
  assignee: null,
  labels: [],
  isEpic: false,
  hasOpenChildren: false,
  truncated: [],
};
const parsed = dispatchSection({
  dispatch: { identity: "factory", pool: { states: ["todo"] } },
  do_item: { claim_marker: true },
});
if (!parsed.ok) throw new Error(parsed.failure.reason);
const section = parsed.value;
const METHODS = [
  "unassignedIssues",
  "stateChangedBy",
  "listRelations",
] as const;

function tracker(method: string, error: unknown): Tracker {
  return {
    adapter: "linear",
    team: "ENG",
    stateName: (s: string) => (s === "todo" ? "Todo" : null),
    assignedIssues: async () => [],
    user: async () => ({ id: "f", name: "factory" }),
    viewer: async () => ({ id: "f", name: "factory" }),
    unassignedIssues: async () => [item],
    stateChangedBy: async () => ({ id: "d", name: "Dana", trusted: true }),
    listRelations: async () => [],
    [method]: async () => {
      throw error;
    },
  } as unknown as Tracker;
}

describe("ready-pool failed-read accounting", () => {
  it("retains a native scope's limit class and scope evidence together", () => {
    const reset = currentMs() + 600000;
    const row = limitedRow(
      { adapter: "github", team: "example/repo" },
      new TrackerRateLimited("github", reset, "fixture limit"),
      { scope: "fixture-scope", readAt: 0 },
    );
    expect(row.failure).toEqual({
      class: "rate-limited",
      until: new Date(reset).toISOString(),
    });
    expect(row.scopeFailure).toBe("fixture-scope");
    expect(row.readFailed).toBeUndefined();
  });
  for (const method of METHODS) {
    for (const failure of [
      "rate-limited",
      "unreachable",
      "unauthorized",
      "defect",
    ] as const)
      it(`${method} retains ${failure}`, async () => {
        const error =
          failure === "rate-limited"
            ? new TrackerRateLimited("linear", currentMs() + 600000, "limit")
            : failure === "defect"
              ? new Error("fixture defect")
              : new OutboundError(failure, "fixture failure");
        const read = await readPickups(() => tracker(method, error), section);
        const row = read.unplaced[0];
        expect(row).toBeDefined();
        expect(row?.readFailed === true).toBe(failure !== "rate-limited");
        expect(row?.failure?.class).toBe(
          failure === "defect" ? undefined : failure,
        );
        expect(read.wanted).toEqual([]);
      });
  }
  it("does not turn a definite absent mover into a failed call", async () => {
    const read = await readPickups(
      () =>
        tracker("stateChangedBy", new AssignerUnknown("no user made it ready")),
      section,
    );
    expect(read.unplaced[0]?.readFailed).toBeUndefined();
    expect(read.unplaced[0]?.reason).toContain("no user made it ready");
  });
});
