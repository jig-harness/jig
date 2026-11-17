/**
 * The tick's report-only priorities ranking over a fixture tick: dispatch's
 * own selection is what it was, the report carries the ranking beside it, and
 * an edit to the host's weights file between two ticks changes the next
 * tick's report with no restart.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([
    assignedIssue(12, "factory-bot", []),
    assignedIssue(13, "factory-bot", []),
  ]);
  w.setAssigner(12, "maintainer", "WRITE");
  w.setAssigner(13, "maintainer", "WRITE");
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--repo", w.repo, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

function priorities(receipt: TickReceipt) {
  const p = receipt.repos[0]?.priorities;
  if (p === undefined || "failed" in p)
    throw new Error(`no priorities part: ${JSON.stringify(p)}`);
  return p;
}

function writeWeights(w: World, text: string): void {
  const dir = join(w.home, ".jig");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "weights.local.yaml"), text);
}

describe("the tick's priorities report", () => {
  it("leaves dispatch's selection as it was and reports the ranking beside it", async () => {
    const receipt = await tick(fixture());
    expect(
      (receipt.repos[0]?.actions ?? []).map((a) => [a.stage, a.target]),
    ).toEqual([
      ["pickup", "#12"],
      ["pickup", "#13"],
    ]);
    const p = priorities(receipt);
    expect(p.ranking.algorithm).toBe("priorities-ranker/1");
    expect(p.ranking.lanes.map((l) => [l.lane, l.share])).toEqual([
      ["core", 0.5],
      ["tactical", 0.25],
      ["peripheral", 0.1],
      ["bug-other", 0.15],
    ]);
    // With no record, the pickups are unallocated work, still visible.
    expect(p.ranking.unallocated.map((u) => u.key).sort()).toEqual([
      "#12",
      "#13",
    ]);
  });

  it("reads the weights file again on the next tick, with no restart", async () => {
    const w = fixture();
    const before = priorities(await tick(w));
    expect(before.weights.problems).toEqual([]);
    writeWeights(w, "lanes:\n  core: 0\n");
    const after = priorities(await tick(w));
    expect(after.ranking.lanes.find((l) => l.lane === "core")).toMatchObject({
      inRotation: false,
      share: 0,
    });
    expect(after.ranking.inputHashes.weights).not.toBe(
      before.ranking.inputHashes.weights,
    );
    writeWeights(w, "lanes: [core: 1\n");
    const broken = await tick(w);
    const p = priorities(broken);
    expect(p.ranking.lanes.every((l) => !l.inRotation)).toBe(true);
    expect(p.weights.problems[0]).toContain("is not YAML");
    // The selection still does not read the ranking.
    expect(
      (broken.repos[0]?.actions ?? []).map((a) => [a.stage, a.target]),
    ).toEqual([
      ["pickup", "#12"],
      ["pickup", "#13"],
    ]);
  });
});
