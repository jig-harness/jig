/**
 * `jig ask --waiting` keeps one entry per target address, and names the
 * question group each need is in with the identity the dashboard's Needs
 * you card carries, so a reader that follows Needs you's rules (the Orca
 * panel's inbox) groups them the same way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LineNeed,
  LineSnapshot,
} from "../../dispatch/lib/dashboard-contract.ts";
import { writeLine } from "../../dispatch/lib/line-store.ts";
import {
  stationContextOf,
  stationDecision,
} from "../../dispatch/lib/line-station.ts";
import { questionGroupId } from "../../shared/question-group.ts";
import { waitingAnswer } from "../lib/waiting.ts";

const REPO = "example-org/web";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A stalled pickup of `item`, framed by the dispatcher as the tick frames it. */
function stalled(item: string): LineNeed {
  const decision = stationDecision(
    {
      stage: "notify",
      target: item,
      record: "tracker",
      reason: "stalled pickup",
      cause: "stalled",
      evidence: { state: "In Progress" },
    },
    stationContextOf(REPO, { tracker: { adapter: "github" } }),
  );
  if (decision === null) throw new TypeError("the fixture frames no decision");
  return {
    cause: "stalled",
    stage: "pickup",
    repo: REPO,
    target: item,
    pr: null,
    item,
    url: `https://github.com/${REPO}/issues/${item.slice(1)}`,
    title: null,
    since: "2026-11-12T10:00:00.000Z",
    reason: "stalled pickup",
    decisions: [decision],
    notified: null,
    workspaces: [],
  };
}

function rootWith(needs: LineNeed[]): string {
  const root = mkdtempSync(join(tmpdir(), "ask-waiting-groups-"));
  roots.push(root);
  writeLine(
    {
      version: 1,
      runId: "2026-11-12T10-00-00-000Z-1-aaaaaaaa",
      startedAt: "2026-11-12T10:00:00.000Z",
      finishedAt: "2026-11-12T10:01:00.000Z",
      exitStatus: 0,
      apply: true,
      applyWithheld: null,
      intervalMs: 300_000,
      longestTickMs: 60_000,
      plugin: "1.2.3",
      accounts: [],
      lastAccount: null,
      sessions: [],
      needs,
      queue: [],
      ready: [],
      repos: [],
    } as unknown as LineSnapshot,
    "{}",
    root,
  );
  return root;
}

describe("jig ask --waiting's question groups", () => {
  it("keeps one entry per target, each naming the group the dashboard's card names", () => {
    const needs = [stalled("#513"), stalled("#514")];
    const unframed = { ...stalled("#515"), decisions: [] };
    const answer = waitingAnswer(rootWith([...needs, unframed]));
    expect(answer.waiting.map((e) => e.address)).toEqual([
      `pickup@${REPO}#513`,
      `pickup@${REPO}#514`,
      `pickup@${REPO}#515`,
    ]);
    const id = questionGroupId(needs[0] as LineNeed);
    expect(id).not.toBeNull();
    expect(answer.waiting.map((e) => e.questionGroup)).toEqual([id, id, null]);
  });
});
