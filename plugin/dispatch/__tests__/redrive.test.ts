/**
 * dispatch --apply: a converged drive whose pull request the forge now
 * reports conflicting with its base, or whose head moved past the head the
 * drive verified, is re-armed once per change; one its base merely moved
 * past, still mergeable at its verified head, is left alone; one whose
 * mergeability the forge is still computing gets nothing that tick.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type EndedRow, readRows } from "../lib/log.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  driveRuns,
  exitWritten,
  machineFile,
  terminalCreates,
  waitFor,
} from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const HEAD = "feature/7-converged";
const MOVED = "b".repeat(40);

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #7, whose drive converged at `HEAD_SHA`, as the forge now lists it; its workspace exists, and account a may bill. */
function fixture(pr: { headRefOid?: string; mergeable?: string }): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, HEAD, pr)]);
  w.setComments(7, [
    ledgerComment(701, stoppedLedger(7, 0, { verifiedSha: HEAD_SHA })),
  ]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

const ended = (w: World) =>
  readRows(undefined, undefined, dispatchState(w)).filter(
    (r): r is EndedRow => r.kind === "ended",
  );

/** Run one tick that re-drives PR #7, and wait for the drive to exit. */
async function redrive(w: World): Promise<string> {
  const [launched] = launches(await tick(w));
  expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  const record = launched?.record ?? "";
  await waitFor("the exit", () => exitWritten(w, record));
  return record;
}

describe("jig dispatch --apply re-drives a stale converged pull request", () => {
  it("re-arms a converged drive the forge reports conflicting exactly once across three ticks", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    const record = await redrive(w);
    const stored = JSON.parse(
      readFileSync(
        join(dispatchState(w), "launches", `${record}.json`),
        "utf8",
      ),
    );
    expect(stored.redrive).toEqual({
      cause: "conflicting with its base",
      change: `head ${HEAD_SHA}, conflicting`,
    });

    // The drive converged again without settling it: the same change is never re-driven twice.
    for (const _ of [2, 3]) {
      const later = await tick(w);
      expect(launches(later)).toEqual([]);
      expect(later.repos[0]?.actions).toEqual([]);
      expect(later.repos[0]?.quiet).toContainEqual({
        target: "PR #7",
        class: "stale",
        why: `stale (conflicting with its base), and launch record ${record} already re-drove it for this change; it is not launched again until its head or its mergeability changes`,
      });
    }
    expect(terminalCreates(w)).toHaveLength(1);
    expect(driveRuns(w)).toHaveLength(1);
  }, 90_000);

  it("re-arms a converged drive whose head moved past the verified head once, and again for the next change", async () => {
    const w = fixture({ headRefOid: MOVED });
    await redrive(w);
    expect(launches(await tick(w))).toEqual([]);

    // Main then conflicts with the new head: a change of its own.
    w.setPrs("open", [
      openPr(7, HEAD, { headRefOid: MOVED, mergeable: "CONFLICTING" }),
    ]);
    await redrive(w);
    expect(launches(await tick(w))).toEqual([]);
    expect(driveRuns(w)).toHaveLength(2);
  }, 90_000);

  it("logs a re-drive's end like any re-arm's, with a reason that names why it was stale", async () => {
    const w = fixture({ headRefOid: MOVED });
    const record = await redrive(w);
    await tick(w);
    const rows = ended(w);
    expect(rows.map((r) => [r.record, r.stage, r.class, r.reason])).toEqual([
      [
        record,
        "rearm",
        "converged",
        "exit 0 (converged); re-drive of a stale converged pull request: head bbbbbbb past the verified head aaaaaaa",
      ],
    ]);
  }, 90_000);

  it("leaves a converged drive still mergeable at its verified head alone", async () => {
    const w = fixture({});
    const receipt = await tick(w);
    expect(launches(receipt)).toEqual([]);
    expect(receipt.repos[0]?.actions).toEqual([]);
    expect(receipt.repos[0]?.quiet).toContainEqual({
      target: "PR #7",
      class: "done",
      why: "stopped 0 (converged), still at the verified head aaaaaaa and mergeable",
    });
    expect(terminalCreates(w)).toEqual([]);
  });

  it("launches nothing for a converged drive whose mergeability the forge is still computing", async () => {
    // Its head moved too: still nothing until the forge says whether it conflicts.
    const w = fixture({ headRefOid: MOVED, mergeable: "UNKNOWN" });
    const receipt = await tick(w);
    expect(launches(receipt)).toEqual([]);
    expect(receipt.repos[0]?.unplaced).toContainEqual({
      target: "PR #7",
      record: "forge",
      reason:
        "stopped 0 (converged), and the forge is still computing whether it conflicts with its base, so whether it is stale cannot be told",
    });
    expect(terminalCreates(w)).toEqual([]);
  });

  it("reports, never relaunches, a re-drive drive.ts refused on the same facts", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    writeFileSync(join(w.dir, "drive-exit"), "11");
    const record = await redrive(w);
    const later = await tick(w);
    expect(launches(later)).toEqual([]);
    expect(later.repos[0]?.quiet).toContainEqual({
      target: "PR #7",
      class: "refused",
      why: `launch record ${record} ended 11, drive.ts's refusal, on these same ledger facts; it is not launched again until they change`,
    });
    expect(terminalCreates(w)).toHaveLength(1);
  }, 90_000);
});
