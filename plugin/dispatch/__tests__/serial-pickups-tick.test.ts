/**
 * dispatch --apply: serialized areas hold pickups. A tick holds each planned
 * pickup whose footprint reaches a serialized area another piece of work in
 * flight touches, says in its receipt, its report and the dashboard's line
 * which item and area hold it, starts the work left, and lets a held pickup
 * start once the work it waited behind ends. Each tick runs in a child with
 * its own home (fixtures.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { readLine } from "../lib/line-store.ts";
import type { OverlapReport } from "../lib/overlap-reasons.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, openPr, SLUG, type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { applyTick, withOrigin } from "./pickup-fixtures.ts";

const CATALOG = `areas:
  dispatch:
    paths: ["src/dispatch/**"]
    serialize: true
    tracker:
      labels: ["area:dispatch"]
  docs:
    paths: ["docs/**"]
    tracker:
      labels: ["area:docs"]
`;

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
drive:
  change_areas_catalog: .config/change-areas.yaml
`;

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** #12 in the serialized dispatch area, #13 in the docs area, #14 with no area label; pull request #20 changes a dispatch file. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
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

type Report = TickReceipt["repos"][number] & {
  serialized?: {
    held: Array<{ target: string; stage: string; reason: string }>;
  };
  overlap?: OverlapReport;
};

const reportOf = (receipt: TickReceipt) => receipt.repos[0] as Report;

const launched = (receipt: TickReceipt) =>
  (reportOf(receipt).launches ?? []).map((l) => [l.target, l.outcome]);

const heldOf = (receipt: TickReceipt) =>
  new Map(
    (reportOf(receipt).serialized?.held ?? [])
      .filter((h) => h.stage === "pickup")
      .map((h) => [h.target, h.reason]),
  );

describe("serialized areas hold pickups", () => {
  it("holds the pickups an occupied area keeps out, says behind what, and starts the rest", async () => {
    const w = fixture();
    const receipt = await applyTick(w, false);
    const held = heldOf(receipt);
    expect(held.get("#12")).toStartWith(
      "held: serialized behind #20 in dispatch; without it the tick would pick it up: ",
    );
    expect(held.get("#14")).toStartWith(
      "held: serialized behind #20 in dispatch, footprint unknown; ",
    );
    expect(held.has("#13")).toBe(false);
    // The account's one slot goes to the pickup no serialized area holds; the held ones are not tried.
    expect(launched(receipt)).toEqual([["#13", "launched"]]);
    // Overlap weighs only the pickups the hold left.
    expect(reportOf(receipt).overlap?.entries.map((e) => e.item)).toEqual([
      "#13",
    ]);

    const line = readLine(dispatchState(w));
    if (!line.ok || line.value === null) throw new Error("no line was written");
    const queued = (line.value as LineSnapshot).queue.find(
      (q) => q.item === "#12",
    );
    expect(queued).toMatchObject({ group: "held", source: "held", hold: null });
    expect(queued?.why).toStartWith("held: serialized behind #20 in dispatch");

    const text = await w.dispatch(["--apply"]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(
      "  held     pickup   #12: held: serialized behind #20 in dispatch",
    );
  }, 120_000);

  it("holds a pickup behind a pull request whose files do not read, and names whose footprint is unknown", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "files-20-fail"), "");
    const r = await w.dispatch(["--apply", "--json"]);
    // The failed file read is a failed read of the tick, which the tick reports and exits 1 on.
    expectSpawnExit(r, 1);
    const held = heldOf(JSON.parse(r.stdout) as TickReceipt);
    expect(held.get("#12")).toStartWith(
      "held: serialized behind #20 in dispatch, #20's footprint unknown; ",
    );
    expect(held.get("#14")).toStartWith(
      "held: serialized behind #20 in dispatch, footprint unknown; ",
    );
    expect(held.has("#13")).toBe(false);
  }, 120_000);

  it("places no pickup while the configured catalog does not read, and says why", async () => {
    const w = fixture();
    w.setRepoFile(".config/change-areas.yaml", "areas: [not, a, catalog]\n");
    const r = await w.dispatch(["--apply", "--json"]);
    // The catalog's failed read is a failed read of the tick.
    expectSpawnExit(r, 1);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    const unplaced = new Map(
      reportOf(receipt).unplaced.map((u) => [u.target, u.reason]),
    );
    for (const item of ["#12", "#13", "#14"])
      expect(unplaced.get(item)).toStartWith(
        "whether it reaches a serialized area cannot be told this tick: ",
      );
    expect(launched(receipt)).toEqual([]);
    // The dashboard's queue shows each one as held, with the reason.
    const line = readLine(dispatchState(w));
    if (!line.ok || line.value === null) throw new Error("no line was written");
    const queued = (line.value as LineSnapshot).queue.find(
      (q) => q.item === "#12",
    );
    expect(queued).toMatchObject({ group: "held", source: "held" });
    expect(queued?.why).toStartWith(
      "whether it reaches a serialized area cannot be told this tick: ",
    );
  }, 120_000);

  it("holds nothing where the catalog marks no area serialized", async () => {
    const w = fixture();
    w.setRepoFile(
      ".config/change-areas.yaml",
      CATALOG.replace("    serialize: true\n", ""),
    );
    const receipt = await applyTick(w, false);
    expect(heldOf(receipt).size).toBe(0);
    expect(
      reportOf(receipt).unplaced.filter((u) => u.target.startsWith("#")),
    ).toEqual([]);
    expect(launched(receipt)).toEqual([
      ["#12", "launched"],
      ["#13", "waits"],
      ["#14", "waits"],
    ]);
  }, 120_000);

  it("releases the hold once the pull request it waited behind is no longer open", async () => {
    const w = fixture();
    w.setIssues([assignedIssue(12, "factory-bot", ["area:dispatch"])]);
    const first = await applyTick(w, false);
    expect(heldOf(first).has("#12")).toBe(true);
    expect(launched(first)).toEqual([]);
    w.setPrs("open", []);
    const second = await applyTick(w, false);
    expect(heldOf(second).size).toBe(0);
    expect(launched(second)).toEqual([["#12", "launched"]]);
  }, 120_000);
});
