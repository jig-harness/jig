/**
 * dispatch: the world view's direct implementation reads what the tick
 * read before it. A tick over a world with a drive running, a drive
 * stopped, a merge and an assigned item makes the same forge calls and the
 * same tracker requests, no more and no fewer. Each tick runs in a child
 * with its own home (fixtures.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { currentIso } from "../../shared/time.ts";
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
import { account, machineFile } from "./launch-fixtures.ts";

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

/** PR #7's drive running with a fresh heartbeat, PR #8's stopped with no exit, PR #5 merged, issue #12 assigned. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  const running = stoppedLedger(7, undefined);
  running.driver = {
    ...running.driver,
    state: "running",
    heartbeat: currentIso(),
  };
  w.setPrs("open", [openPr(7, "feature/7"), openPr(8, "feature/8")]);
  w.setComments(7, [ledgerComment(701, running)]);
  w.setComments(8, [ledgerComment(801, stoppedLedger(8, undefined))]);
  w.setPrs("merged", [mergedPr(5, "feature/5", "2026-10-31T00:00:00Z")]);
  w.setComments(5, []);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  machineFile(w, [account(w, "a", "a@example.com")], {}, [
    "rearm",
    "pickup",
    "followup",
  ]);
  return w;
}

/** Every `gh` call the fake answered, a GraphQL query by its operation's name. */
function ghCalls(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(line)?.[1];
      return op === undefined ? line : `graphql ${op}`;
    });
}

describe("the world view's direct implementation", () => {
  it("makes the calls a tick made before it, no new read and no write", async () => {
    const w = fixture();
    const r = await w.dispatch([
      "--followup-since",
      "2026-10-30T00:00:00Z",
      "--json",
    ]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    // The tick still plans from what it read: the pickup, the re-arm and the follow-up.
    expect(
      (receipt.repos[0]?.actions ?? []).map((a) => `${a.stage} ${a.target}`),
    ).toEqual(["pickup #12", "rearm PR #8", "followup PR #5"]);
    expect(ghCalls(w).toSorted()).toEqual([
      "api --paginate --slurp repos/example-org/example-repo/issues/5/comments?per_page=100",
      "api rate_limit",
      "api user --jq .login",
      "graphql DispatchRepository",
      "pr list --repo example-org/example-repo --state merged --search merged:>=2026-10-30 --limit 1000 --json number,url,title,headRefName,createdAt,mergedAt,updatedAt",
    ]);
    expect(w.trackerOps().toSorted()).toEqual([
      "TrackerAssignedBy",
      "TrackerCollaborator",
      "TrackerComments",
      "TrackerDispatchQueue",
      "TrackerFacetEvidence",
      "TrackerIssue",
    ]);
  });
});
