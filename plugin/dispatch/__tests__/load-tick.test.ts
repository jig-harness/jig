/**
 * dispatch --apply with the host's load: every tick reads the gauges under
 * the act lock and reports them, the load factor and the gauge that binds
 * on its receipt and the line. Without `load.enforce` a launch a gauge
 * refuses still starts and is reported as one the load factor would hold;
 * with it, the launch waits, and a pickup keeps room for a drive.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  assignedIssue,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;
const GIB = 1024 ** 3;
const TOTAL = 16 * GIB;
/** The 15% of memory the default line keeps free. */
const FLOOR = TOTAL * 0.15;
const BRANCH = "feature/7-parked";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** The host the tick reads: 16 GiB with `left` bytes available above the floor, idle otherwise. */
function host(w: World, left: number): Record<string, string> {
  const path = join(w.root, "load-reading.json");
  writeFileSync(
    path,
    JSON.stringify({
      load1: 1,
      cores: 8,
      totalBytes: TOTAL,
      availableBytes: FLOOR + left,
      diskFreeBytes: 500 * GIB,
      diskTotalBytes: 1000 * GIB,
      lockHolders: 0,
      lockWaiters: 0,
    }),
  );
  return { JIG_DISPATCH_LOAD_READING: path };
}

function git(w: World, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    env: w.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
}

/** Issue #12 assigned to the factory identity, and with `rearm` PR #7 stopped and re-armable. */
function fixture(stages: string[], load: Record<string, unknown> = {}): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  withOrigin(w);
  machineFile(
    w,
    [{ ...account(w, "a", "a@example.com"), max: 4 }],
    Object.keys(load).length === 0 ? {} : { load },
    stages,
  );
  if (stages.includes("rearm")) {
    w.setPrs("open", [openPr(7, BRANCH)]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
    git(w, "-C", w.repo, "branch", BRANCH, "main");
    git(w, "-C", w.repo, "push", "-q", "origin", BRANCH);
  }
  w.setWorkspaces([]);
  return w;
}

async function tick(
  w: World,
  extra: Record<string, string>,
): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"], undefined, extra);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

describe("jig dispatch reads the host's load each tick", () => {
  it("carries each gauge, the load factor and the gauge that binds on the receipt and the line", async () => {
    const w = fixture(["pickup"]);
    // 1 GiB above the floor: 12.6 GiB used of 13.6 usable, 93%.
    const receipt = await tick(w, host(w, 1 * GIB));
    expect(receipt.load?.gauges.map((g) => g.gauge)).toEqual([
      "memory",
      "processors",
      "test-lock",
      "disk",
      "forge",
      "accounts",
    ]);
    expect(receipt.load).toMatchObject({ enforce: false, binds: "memory" });
    expect(receipt.load?.factor).toBeCloseTo(12.6 / 13.6, 3);
    const answer = await w.dispatch(["line", "--json"]);
    expectSpawnExit(answer, 0);
    const { line } = (
      JSON.parse(answer.stdout) as { value: { line: LineSnapshot } }
    ).value;
    expect(line.load).toMatchObject({
      binds: "memory",
      factor: receipt.load?.factor,
      holds: receipt.load?.holds,
    });
  });

  it("without enforcement starts the launch a gauge refuses, and reports it as one it would hold", async () => {
    const w = fixture(["pickup"]);
    const receipt = await tick(w, host(w, 1 * GIB));
    expect(launches(receipt)).toMatchObject([
      { action: "pickup", target: "#12", outcome: "launched" },
    ]);
    expect(receipt.load?.holds).toMatchObject([
      {
        repo: SLUG,
        target: "#12",
        kind: "pickup",
        gauge: "memory",
        held: false,
      },
    ]);
  });

  it("with enforcement and one drive's headroom left, admits the re-arm and holds the pickup", async () => {
    const w = fixture(["rearm", "pickup"], { enforce: true });
    const receipt = await tick(w, host(w, 1.6 * GIB));
    const byTarget = new Map(launches(receipt).map((l) => [l.target, l]));
    expect(byTarget.get("PR #7")).toMatchObject({
      action: "rearm",
      outcome: "launched",
    });
    expect(byTarget.get("#12")).toMatchObject({
      action: "pickup",
      outcome: "waits",
      detail: expect.stringContaining("the host's load holds it: memory binds"),
    });
    expect(receipt.load?.holds).toMatchObject([
      { target: "#12", kind: "pickup", gauge: "memory", held: true },
    ]);
  });
});
