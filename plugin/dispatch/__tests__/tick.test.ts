/**
 * dispatch: one tick over a fake tracker, forge and Orca, run as the
 * installed command in a child with its own home.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  assignedIssue,
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  followup_command: /followup
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** One assigned item, one quota-parked pull request and one merged one. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  w.setPrs("merged", [mergedPr(5, "feature/5-merged", "2026-10-30T12:00:00Z")]);
  return w;
}

async function tick(w: World, ...args: string[]): Promise<TickReceipt> {
  const r = await w.dispatch([
    "--repo",
    w.repo,
    "--followup-since",
    "2026-10-30T00:00:00Z",
    "--json",
    ...args,
  ]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const actions = (receipt: TickReceipt) =>
  (receipt.repos[0]?.actions ?? []).map((a) => [a.stage, a.target, a.record]);

describe("jig dispatch reports what it would start", () => {
  it("lists one action per wanted stage, each naming the record that wants it", async () => {
    const receipt = await tick(fixture());
    expect(actions(receipt)).toEqual([
      ["pickup", "#12", "tracker"],
      ["rearm", "PR #7", "forge"],
      ["followup", "PR #5", "forge"],
    ]);
    const [pickup, rearm] = receipt.repos[0]?.actions ?? [];
    expect(pickup?.evidence.assignedBy).toBe("maintainer");
    expect(rearm?.reason).toContain("stopped 16 (quota-parked");
    expect(rearm?.evidence.generation).toBe(3);
  });

  it("removes the action of an item a running session holds", async () => {
    const w = fixture();
    w.setWorkspaces([
      { branch: "12-the-item", agents: [{ state: "working" }] },
    ]);
    const receipt = await tick(w);
    expect(actions(receipt)).toEqual([
      ["rearm", "PR #7", "forge"],
      ["followup", "PR #5", "forge"],
    ]);
    expect(receipt.repos[0]?.running.map((r) => r.target)).toEqual(["#12"]);
  });

  it("plans again for a workspace whose agent is done, with that state as evidence", async () => {
    const w = fixture();
    w.setWorkspaces([{ branch: "12-the-item", agents: [{ state: "done" }] }]);
    const receipt = await tick(w);
    const pickup = receipt.repos[0]?.actions[0];
    expect(pickup?.target).toBe("#12");
    expect(pickup?.evidence.finishedSessions).toBe("12-the-item: done");
  });

  it("gives a ledger a person stopped no action", async () => {
    const w = fixture();
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 18))]);
    const receipt = await tick(w);
    expect(actions(receipt)).toEqual([
      ["pickup", "#12", "tracker"],
      ["followup", "PR #5", "forge"],
    ]);
    expect(receipt.repos[0]?.quiet).toEqual([
      {
        target: "PR #7",
        class: "stopped-by-person",
        why: "stopped 18 (a mailbox stop): a person's stop is never re-armed",
      },
    ]);
  });

  it("reports, and never plans, an item assigned by someone who cannot write", async () => {
    const w = fixture();
    w.setAssigner(12, "drive-by", "READ");
    const receipt = await tick(w);
    expect(actions(receipt).map((a) => a[1])).toEqual(["PR #7", "PR #5"]);
    expect(receipt.repos[0]?.unplaced[0]?.reason).toContain(
      "by drive-by, who cannot write",
    );
  });

  it("plans nothing for a target the runtime cannot vouch for", async () => {
    const w = fixture();
    w.setWorkspaces([
      { branch: "feature/7-parked", unverifiableTerminalCount: 1 },
    ]);
    const receipt = await tick(w);
    expect(actions(receipt).map((a) => a[1])).toEqual(["#12", "PR #5"]);
    expect(receipt.repos[0]?.unplaced).toEqual([
      {
        target: "PR #7",
        record: "runtime",
        reason:
          "workspace /ws/0 has 1 terminal(s) whose agents the runtime cannot report",
      },
    ]);
  });

  it("plans nothing for a target whose agent has no readable state", async () => {
    const w = fixture();
    w.setWorkspaces([
      {
        branch: "feature/7-parked",
        agents: [{} as unknown as { state: string }],
      },
    ]);
    const receipt = await tick(w);
    expect(receipt.repos[0]?.unplaced.map((u) => u.target)).toContain("PR #7");
    expect(actions(receipt).map((a) => a[1])).not.toContain("PR #7");
  });

  it("refuses a dispatch section that is a timestamp", async () => {
    const w = fixture();
    w.setConfig("dispatch: 2026-10-31\n");
    const r = await w.dispatch(["--repo", w.repo, "--json"]);
    expectSpawnExit(r, 1);
    expect((JSON.parse(r.stdout) as TickReceipt).repos[0]?.refused).toContain(
      "dispatch must be a mapping",
    );
  });

  it("reads the dispatch section from the default branch: none there, no pickups or follow-ups", async () => {
    const w = fixture();
    w.setConfig(null);
    const r = await w.dispatch(["--repo", w.repo, "--json"]);
    expectSpawnExit(r, 0);
    expect(actions(JSON.parse(r.stdout) as TickReceipt)).toEqual([
      ["rearm", "PR #7", "forge"],
    ]);
    // The checkout's own file is never read.
    expect(existsSync(join(w.repo, ".config", "jig.yaml"))).toBe(false);
    expect(readFileSync(join(w.dir, "gh-calls.log"), "utf8")).toContain(
      `repos/${SLUG}/contents/.config/jig.yaml?ref=main`,
    );
  });
});

describe("jig dispatch receipts", () => {
  it("writes one receipt per tick, which the next tick reads for the follow-up window", async () => {
    const w = fixture();
    await tick(w);
    const second = await w.dispatch(["--repo", w.repo, "--json"]);
    expectSpawnExit(second, 0);
    const receipt = JSON.parse(second.stdout) as TickReceipt;
    expect(receipt.repos[0]?.followupSince).toBe("2026-10-30T00:00:00.000Z");
    const listed = await w.dispatch(["receipts"]);
    expectSpawnExit(listed, 0);
    expect(listed.stdout.trim().split("\n")).toHaveLength(2);
  });
});

describe("jig dispatch --apply", () => {
  it("is refused without a machine file, naming it, and starts nothing", async () => {
    const w = fixture();
    const r = await w.dispatch(["--repo", w.repo, "--apply"]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain(
      `jig dispatch --apply needs the machine file ${join(w.home, ".jig", "dispatch.yaml")}`,
    );
    const receipts = join(
      w.home,
      ".local",
      "state",
      "jig",
      "dispatch",
      "receipts",
    );
    expect(existsSync(receipts) ? readdirSync(receipts) : []).toEqual([]);
  });
});
