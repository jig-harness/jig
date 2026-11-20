/**
 * dispatch --apply: overlap, reported. A tick weighs the pickups it plans
 * against the open pull requests' changed files and says, in its receipt,
 * on the dashboard's line and in the repository's report, why each one that
 * overlaps waits and whose footprint is unknown; it starts the same work it
 * would start without overlap, in the same order. Each tick runs in a child
 * with its own home (fixtures.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import type { OverlapReport } from "../lib/overlap-reasons.ts";
import { readLine } from "../lib/line-store.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, openPr, SLUG, type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { applyTick, withOrigin } from "./pickup-fixtures.ts";

const CATALOG = `areas:
  dispatch:
    paths: ["src/dispatch/**"]
    tracker:
      labels: ["area:dispatch"]
  docs:
    paths: ["docs/**"]
    tracker:
      labels: ["area:docs"]
`;

const config = (overlap = "") => `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
${overlap}drive:
  change_areas_catalog: .config/change-areas.yaml
`;

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** #12 in the dispatch area, #13 in the docs area, #14 with no area label; pull request #20 changes a dispatch file. */
function fixture(overlap = ""): World {
  const w = world();
  current = w;
  w.setConfig(config(overlap));
  w.setRepoFile(".config/change-areas.yaml", CATALOG);
  w.setIssues([
    assignedIssue(12, "factory-bot", ["area:dispatch"]),
    assignedIssue(13, "factory-bot", ["area:docs"]),
    assignedIssue(14, "factory-bot", []),
  ]);
  for (const n of [12, 13, 14]) w.setAssigner(n, "maintainer", "WRITE");
  w.setPrs("open", [openPr(20, "feature/20")]);
  w.setFiles(20, ["src/dispatch/load.ts"]);
  withOrigin(w);
  machineFile(w, [{ ...account(w, "a", "a@example.com"), max: 1 }], {}, [
    "pickup",
  ]);
  return w;
}

const overlapOf = (receipt: TickReceipt): OverlapReport | undefined =>
  (receipt.repos[0] as { overlap?: OverlapReport } | undefined)?.overlap;

const launched = (receipt: TickReceipt) =>
  (receipt.repos[0]?.launches ?? []).map((l) => [l.target, l.outcome]);

describe("overlap, reported", () => {
  it("says why each planned pickup waits and whose footprint is unknown, and starts what the plan ranks first", async () => {
    const w = fixture();
    const receipt = await applyTick(w, false);
    const overlap = overlapOf(receipt);
    expect(overlap?.inFlight).toEqual({
      pullRequests: 1,
      pickups: 0,
      unknown: [],
    });
    const entries = new Map(overlap?.entries.map((e) => [e.item, e]));
    expect(entries.get("#12")).toMatchObject({
      tier: 2,
      cost: 0.2,
      footprint: "labels",
      footprintNote:
        "footprint unknown: no footprint record; derived from its area labels (dispatch)",
      reason: {
        relation: "waits on overlap",
        item: "#12",
        on: [
          {
            kind: "pull request",
            ref: "#20",
            state: "open",
            url: `https://github.com/${SLUG}/pull/20`,
          },
        ],
        count: 1,
      },
    });
    expect(entries.get("#12")?.reason?.text).toStartWith(
      "waits on overlap: shares area dispatch with #20 (pull request); 0.2 rounds expected; first when a slot is free after work that does not overlap, or from ",
    );
    expect(entries.get("#13")).toMatchObject({
      tier: 1,
      cost: 0,
      footprint: "labels",
    });
    expect(entries.get("#13")?.reason).toBeUndefined();
    expect(entries.get("#14")).toMatchObject({
      tier: 2,
      cost: 0.5,
      footprint: "unknown",
      footprintNote: "footprint unknown: no footprint record and no area label",
    });
    // The rates file has never been written: every rate is at its default, and the receipt says so.
    expect(overlap?.rates.defaulted).toContain("no conflict rates");
    // Reported only: the account's one slot goes to the pickup the plan ranks first, #12, though it waits on overlap and #13 does not.
    expect(entries.get("#12")?.rank).toBe(1);
    expect(launched(receipt)).toEqual([
      ["#12", "launched"],
      ["#13", "waits"],
      ["#14", "waits"],
    ]);

    const line = readLine(dispatchState(w));
    if (!line.ok || line.value === null) throw new Error("no line was written");
    const queued = (line.value as LineSnapshot).queue.find(
      (q) => q.item === "#14",
    );
    expect(queued?.overlap?.relation).toBe("waits on overlap");
    expect(queued?.footprint).toBe(
      "footprint unknown: no footprint record and no area label",
    );

    // The next tick counts the started pickup in flight, and its report says so.
    const text = await w.dispatch(["--apply"]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      "  overlap  in flight: 1 pull request(s), 1 pickup(s)",
    );
    expect(text.stdout).toContain(
      "  overlap  #14 (rank 2) tier 2, 0.5 round(s): waits on overlap: its footprint is unknown",
    );
  }, 120_000);

  it("refuses a section with an unknown overlap key, as it refuses any unknown key", async () => {
    const w = fixture("  overlap:\n    width: 2\n");
    const r = await w.dispatch(["--json"]);
    // A repository the tick could not read is a failed tick.
    expectSpawnExit(r, 1);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(receipt.repos[0]?.refused).toContain(
      "dispatch.overlap has unknown key(s): width",
    );
  }, 60_000);
});
