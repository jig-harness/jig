/** Real ticks retain the failure of each factory tracker read, independently of repository reads. */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { FAILURE_DEFAULTS, readFailures } from "../lib/failures.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";

const TRACKER = resolve(
  import.meta.dir,
  "../../skills/do-item/scripts/lib/tracker",
);
const DISPATCH = resolve(import.meta.dir, "..");
const SHARED = resolve(import.meta.dir, "../../shared");
type Kind = "claimed" | "assigner" | "marker";
type Refusal =
  | "rate-limited"
  | "unreachable"
  | "unauthorized"
  | "defect"
  | "absent";
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** The ordinary tracker remains real; only the selected port call refuses. The legacy path exercises its separate claimed listing. */
function entry(
  w: World,
  kind: Kind,
  refusal: Refusal,
  later?: "assigner" | "claimed",
): string {
  const path = join(w.root, "tracker-tick.ts");
  writeFileSync(
    path,
    `import { mock } from "bun:test";
import * as original from ${JSON.stringify(`${TRACKER}/index.ts`)};
import { AssignerUnknown } from ${JSON.stringify(`${TRACKER}/assigner-unknown.ts`)};
import { OutboundError } from ${JSON.stringify(`${SHARED}/outbound/failure.ts`)};
import { TrackerRateLimited } from ${JSON.stringify(`${SHARED}/outbound/budget.ts`)};
import { currentMs } from ${JSON.stringify(`${SHARED}/time.ts`)};
const open = original.openTracker;
const kind = ${JSON.stringify(kind)};
const refusal = ${JSON.stringify(refusal)};
const later = ${JSON.stringify(later ?? null)};
function refuse() {
  if (refusal === "rate-limited") throw new TrackerRateLimited("github", currentMs() + 600000, "fixture limit");
  if (refusal === "absent") throw new AssignerUnknown("its complete history holds no assignment");
  if (refusal === "defect") throw new Error("unexpected fixture defect");
  throw new OutboundError(refusal, "fixture refused this read");
}
mock.module(${JSON.stringify(`${TRACKER}/index.ts`)}, () => ({ ...original, openTracker: (...args) => {
  const tracker = open(...args);
  // The optional native queue combines listings; this test also covers adapters using the separate port reads.
  if (kind !== "marker") delete tracker.dispatchSource;
  if (kind === "claimed") {
    const assigned = tracker.assignedIssues.bind(tracker);
    tracker.assignedIssues = (identity, states, options) => states.includes("in_progress") ? refuse() : assigned(identity, states, options);
  } else if (kind === "assigner") tracker.assignedBy = async () => refuse();
  else tracker.issueComments = async () => refuse();
  if (later !== null) {
    const assigned = tracker.assignedIssues.bind(tracker);
    tracker.assignedIssues = (identity, states, options) => {
      if (later === "claimed" && states.includes("in_progress")) throw new TrackerRateLimited("github", currentMs() + 600000, "later limit");
      return assigned(identity, states, options);
    };
    tracker.assignedBy = async (key) => {
      if (key === "#9") return refuse();
      throw new TrackerRateLimited("github", currentMs() + 600000, "later limit");
    };
  }
  return tracker;
}}));
const { readMachineConfig } = await import(${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)});
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const read = readMachineConfig();
if (!read.ok || read.value === null) throw new Error("the fixture needs a machine file");
const result = await runTick({ repos: [process.cwd()], apply: true, machine: read.value });
if ("held" in result) throw new Error("fixture tick lock held");
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`,
  );
  return path;
}

function fixture(kind: Kind): World {
  const w = world();
  current = w;
  w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  stalled_scope: claimed
`);
  w.setIssues([
    assignedIssue(
      kind === "assigner" ? 9 : 8,
      "factory-bot",
      kind === "assigner" ? [] : ["In Progress"],
    ),
  ]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
  return w;
}

async function tick(
  w: World,
  kind: Kind,
  refusal: Refusal,
  later?: "assigner" | "claimed",
) {
  const r = await w.dispatch([], entry(w, kind, refusal, later));
  const expected = refusal === "unauthorized" || refusal === "defect" ? 1 : 0;
  expectSpawnExit(r, expected);
  return JSON.parse(r.stdout) as TickReceipt;
}

describe("a factory tracker call that fails before the tick deadline", () => {
  for (const later of ["assigner", "claimed"] as const)
    for (const refusal of ["unauthorized", "defect"] as const)
      it(`keeps an earlier ${refusal} when a later ${later} read is rate limited`, async () => {
        const w = fixture("assigner");
        if (later === "assigner")
          w.setIssues([
            assignedIssue(9, "factory-bot", []),
            assignedIssue(10, "factory-bot", []),
          ]);
        const receipt = await tick(w, "assigner", refusal, later);
        const rows = receipt.repos[0]?.unplaced ?? [];
        const earlier = rows.find((u) => u.target === "#9");
        expect(earlier?.readFailed).toBe(true);
        expect(earlier?.failure?.class).toBe(
          refusal === "defect" ? undefined : refusal,
        );
        expect(rows).toContainEqual(
          expect.objectContaining({
            failure: expect.objectContaining({ class: "rate-limited" }),
          }),
        );
      }, 60_000);

  for (const kind of ["claimed", "assigner", "marker"] as const) {
    for (const refusal of [
      "rate-limited",
      "unreachable",
      "unauthorized",
    ] as const)
      it(`${kind}: ${refusal} reaches the real tick's policy and ledger`, async () => {
        const w = fixture(kind);
        const receipt = await tick(w, kind, refusal);
        const row = receipt.repos[0]?.unplaced.find(
          (u) => u.failure?.class === refusal,
        );
        expect(row).toBeDefined();
        expect(row?.readFailed === true).toBe(refusal !== "rate-limited");
        const failed = readFailures(undefined, dispatchState(w)).filter(
          (r) => r.kind === "repository",
        );
        expect(failed.map((r) => r.count)).toEqual(
          refusal === "rate-limited"
            ? []
            : [refusal === "unauthorized" ? FAILURE_DEFAULTS.notifyAfter : 1],
        );
        expect(
          receipt.failures?.escalated.some((r) => r.kind === "repository") ??
            false,
        ).toBe(refusal === "unauthorized");
      }, 60_000);

    it(`${kind}: an unclassified defect fails rather than being waited out`, async () => {
      const w = fixture(kind);
      const receipt = await tick(w, kind, "defect");
      expect(receipt.repos[0]?.unplaced).toContainEqual(
        expect.objectContaining({
          readFailed: true,
          reason: expect.stringContaining("unexpected fixture defect"),
        }),
      );
    }, 60_000);
  }

  it("keeps a complete no-assignment answer informational", async () => {
    const w = fixture("assigner");
    const receipt = await tick(w, "assigner", "absent");
    const row = receipt.repos[0]?.unplaced.find((u) => u.target === "#9");
    expect(row?.reason).toContain("complete history holds no assignment");
    expect(row?.readFailed).toBeUndefined();
    expect(readFailures(undefined, dispatchState(w))).toEqual([]);
  }, 60_000);
});
