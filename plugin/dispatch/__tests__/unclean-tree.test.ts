/** Bounded recovery of a converged drive's uncommitted work in its original tree. */
import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { cloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { currentIso, currentMs, isoFromMs } from "../../shared/time.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { REARM_REQUEST } from "../lib/rearm-binding.ts";
import { statePath } from "../lib/state.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
  checkoutOn,
  mergedPr,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { endHolder, holdLock } from "./host-driver-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});
function fixture(tree = true) {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [openPr(7, "feature/unclean")]);

  const ws = join(w.root, "original-dirty-tree");
  checkoutOn(w.repo, ws, "feature/unclean", w.env);
  const ledger = stoppedLedger(7, 12);
  ledger.driver.clone = cloneId(cloneKey(join(w.repo, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  w.setComments(7, [ledgerComment(701, ledger)]);
  w.setWorkspaces(
    tree ? [{ branch: "feature/unclean", linkedPR: 7, path: ws }] : [],
  );
  machineFile(w, [account(w, "a", "a@example.com")]);
  return { w, ws, ledger };
}
function requestFor(ledger: Ledger, id = 702, at = currentIso()) {
  return forgeComment(
    id,
    claimBody(REARM_REQUEST, {
      key: "rearm",
      generation: ledger.generation,
      writer: localWriter("forge", "maintainer"),
      at,
      payload: { label: "jig:rearm", stopComment: 701 },
      text: "",
    }),
    "maintainer",
    "MEMBER",
  );
}

function request(w: World, ledger: Ledger, id = 702): void {
  w.setConfig(
    `dispatch:\n  labels: {enabled: true}\nissue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
  w.setComments(7, [ledgerComment(701, ledger), requestFor(ledger, id)]);
}

async function tick(w: World, exit = 0) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, exit);
  return JSON.parse(r.stdout) as TickReceipt;
}
it("retries exit 12 once per head in the same tree with a settlement pass", async () => {
  const { w, ws } = fixture();
  const first = await tick(w);
  const launch = first.repos[0]?.launches[0];
  expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the recovery exit", () =>
    exitWritten(w, launch?.record ?? ""),
  );
  expect(
    readRecord(launch?.record ?? "", dispatchState(w))?.workspace?.path,
  ).toBe(ws);
  expect(driveRuns(w)[0]?.argv).toContain("--settle-worktree");
  expect(driveRuns(w)[0]?.argv.at(-1)).toContain("uncommitted work");
  const second = await tick(w);
  expect(second.repos[0]?.launches).toEqual([]);
  expect(
    second.repos[0]?.actions.some(
      (a) => a.stage === "notify" && a.reason.includes("12"),
    ),
  ).toBe(true);
  w.setPrs("open", [
    openPr(7, "feature/unclean", { headRefOid: "b".repeat(40) }),
  ]);
  expect((await tick(w)).repos[0]?.launches[0]).toMatchObject({
    outcome: "launched",
  });
}, 90000);
it("never opens a fresh tree for exit 12", async () => {
  const { w } = fixture(false);
  const r = await tick(w);
  expect(r.repos[0]?.launches).toEqual([]);
  expect(r.repos[0]?.actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stage: "notify",
        reason: expect.stringContaining("no open workspace"),
      }),
    ]),
  );
  expect(driveRuns(w)).toEqual([]);
});

it("waits before retiring an explicit rearm whose original tree is missing", async () => {
  const { w, ledger } = fixture(false);
  request(w, ledger);
  const waiting = (await tick(w)).repos[0];
  expect(waiting?.launches).toContainEqual(
    expect.objectContaining({ action: "rearm", outcome: "waits" }),
  );
  expect(waiting?.actions.some((action) => action.stage === "notify")).toBe(
    false,
  );

  ageWait(w, "tree", 31);
  const retired = (await tick(w)).repos[0];
  expect(retired?.actions).toContainEqual(
    expect.objectContaining({
      stage: "notify",
      cause: "needs-person",
      reason: expect.stringContaining(
        "matching the stopped driver's actor and clone",
      ),
    }),
  );
  expect(driveRuns(w)).toEqual([]);
}, 90000);

it("clears a tree wait after its rearm request is withdrawn", async () => {
  const { w, ledger } = fixture(false);
  request(w, ledger);
  await tick(w);
  using db = new Database(statePath(dispatchState(w)));
  expect(
    db
      .query(
        "SELECT count(*) AS count FROM rearm_waits WHERE repo = ? AND pr = ?",
      )
      .get(SLUG, 7),
  ).toEqual({ count: 1 });

  w.setPrs("open", [openPr(7, "feature/unclean")]);
  await tick(w);
  expect(
    db
      .query(
        "SELECT count(*) AS count FROM rearm_waits WHERE repo = ? AND pr = ?",
      )
      .get(SLUG, 7),
  ).toEqual({ count: 0 });
}, 90000);

it("bounds a reused original tree that no longer proves the pull request checkout", async () => {
  const { w, ws, ledger } = fixture();
  request(w, ledger);
  const tree = Bun.spawnSync(["git", "-C", ws, "rev-parse", "HEAD^{tree}"], {
    env: w.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(tree, 0, "read the reused tree");
  const stale = Bun.spawnSync(
    [
      "git",
      "-C",
      ws,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit-tree",
      tree.stdout.toString().trim(),
      "-m",
      "stale checkout",
    ],
    { env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(stale, 0, "create a stale checkout");
  const checkout = Bun.spawnSync(
    ["git", "-C", ws, "checkout", "--detach", stale.stdout.toString().trim()],
    { env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(checkout, 0, "reuse the tree on another history");

  const waiting = (await tick(w)).repos[0];
  expect(waiting?.launches).toContainEqual(
    expect.objectContaining({ action: "rearm", outcome: "waits" }),
  );
  ageWait(w, "tree", 31);
  const retired = (await tick(w)).repos[0];
  expect(retired?.actions).toContainEqual(
    expect.objectContaining({
      stage: "notify",
      cause: "needs-person",
      reason: expect.stringContaining("is not proven to be PR #7's checkout"),
    }),
  );
  expect(driveRuns(w)).toEqual([]);
}, 90000);

it("honors an explicit rearm request on a needs-person stop in the existing tree", async () => {
  const { w, ws } = fixture();
  const ledger = stoppedLedger(7, 14);
  ledger.driver.clone = cloneId(cloneKey(join(w.repo, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  request(w, ledger);
  const r = await tick(w);
  const launch = r.repos[0]?.launches[0];
  expect(launch).toMatchObject({ outcome: "launched" });
  await waitFor("the explicit rearm exit", () =>
    exitWritten(w, launch?.record ?? ""),
  );
  expect(driveRuns(w)[0]?.cwd).toBe(ws);
  expect(driveRuns(w)[0]?.argv).not.toContain("--settle-worktree");
  expect(
    readRecord(launch?.record ?? "", dispatchState(w))?.rearmConsumed,
  ).toBe(true);
  request(w, ledger, 703);
  const again = await tick(w);
  expect(again.repos[0]?.launches[0]?.outcome).toBe("launched");
  await waitFor("the second explicit rearm exit", () =>
    exitWritten(w, again.repos[0]?.launches[0]?.record ?? ""),
  );
}, 90000);

it("retries a failed request-label removal without launching again", async () => {
  const { w, ledger } = fixture();
  request(w, ledger);
  const failure = join(w.dir, "label-edit-fail");
  writeFileSync(failure, "refuse label writes");
  const first = await tick(w);
  const id = first.repos[0]?.launches[0]?.record ?? "";
  expect(first.repos[0]?.launches[0]?.outcome).toBe("launched");
  expect(first.repos[0]?.launches[0]?.detail).toContain("could not be removed");
  await waitFor("the accepted request exit", () => exitWritten(w, id));
  expect(readRecord(id, dispatchState(w))?.rearmConsumed).not.toBe(true);
  await tick(w);
  expect(driveRuns(w)).toHaveLength(1);
  rmSync(failure);
  await tick(w);
  expect(readRecord(id, dispatchState(w))?.rearmConsumed).toBe(true);
  expect(driveRuns(w)).toHaveLength(1);
}, 90000);

it("refuses a clean same-branch tree belonging to another driver", async () => {
  const { w } = fixture();
  const ledger = stoppedLedger(7, 12);
  ledger.driver.clone = cloneId(cloneKey(join(w.repo, ".git")));
  ledger.driver.actor = "wt-0000000000000000";
  w.setComments(7, [ledgerComment(701, ledger)]);
  const report = (await tick(w)).repos[0];
  expect(report?.launches).toEqual([]);
  expect(report?.actions.some((a) => a.stage === "notify")).toBe(true);
  expect(driveRuns(w)).toEqual([]);
});

it("refuses the same path in another clone", async () => {
  const { w, ws } = fixture();
  const ledger = stoppedLedger(7, 12);
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  ledger.driver.clone = `another-clone@${cloneId(cloneKey(join(w.repo, ".git")))
    .split("@")
    .at(-1)}`;
  w.setComments(7, [ledgerComment(701, ledger)]);
  expect((await tick(w)).repos[0]?.launches[0]).toMatchObject({
    outcome: "waits",
  });
  expect(driveRuns(w)).toEqual([]);
});

it("refuses an ambiguous runtime listing of the original tree", async () => {
  const { w, ws } = fixture();
  w.setWorkspaces([
    { branch: "feature/unclean", linkedPR: 7, path: ws },
    { branch: "feature/unclean", linkedPR: 7, path: ws },
  ]);
  expect((await tick(w)).repos[0]?.launches[0]).toMatchObject({
    outcome: "waits",
  });
  expect(driveRuns(w)).toEqual([]);
});

it("admits an explicit request after the legacy automatic no-cause attempt is spent", async () => {
  const { w, ws } = fixture();
  const ledger = stoppedLedger(7, undefined);
  ledger.driver.clone = cloneId(cloneKey(join(w.repo, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  w.setComments(7, [ledgerComment(701, ledger)]);
  const first = await tick(w);
  const id = first.repos[0]?.launches[0]?.record ?? "";
  expect(first.repos[0]?.launches[0]?.outcome).toBe("launched");
  await waitFor("the automatic recovery exit", () => exitWritten(w, id));
  request(w, ledger);
  const next = await tick(w);
  const launched = next.repos[0]?.launches.find((l) => l.action === "rearm");
  expect(launched?.outcome).toBe("launched");
  await waitFor("the explicit recovery exit", () =>
    exitWritten(w, launched?.record ?? ""),
  );
  expect(
    readRecord(launched?.record ?? "", dispatchState(w))?.facts,
  ).not.toStartWith("no-cause:");
}, 90000);

it("recovers an original tree that is detached, found by its pull request link", async () => {
  const { w, ws } = fixture();
  w.setWorkspaces([{ branch: "", linkedPR: 7, path: ws }]);
  const launch = (await tick(w)).repos[0]?.launches[0];
  expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the detached-tree recovery exit", () =>
    exitWritten(w, launch?.record ?? ""),
  );
  expect(driveRuns(w)[0]?.cwd).toBe(ws);
}, 90000);

function ageWait(
  w: World,
  kind: "tree" | "stop" | "capacity",
  minutes: number,
) {
  using db = new Database(statePath(dispatchState(w)));
  const result = db
    .query(
      "UPDATE rearm_waits SET since_ms = ? WHERE repo = ? AND pr = 7 AND request_id = 702 AND kind = ?",
    )
    .run(currentMs() - minutes * 60_000, SLUG, kind);
  expect(result.changes).toBe(1);
}

it("retires an explicit request and raises a need when the tree now holds another pull request", async () => {
  const { w, ws, ledger } = fixture();
  ledger.driver.exit = DRIVE_EXIT.CI_INFRA_PERSISTED;
  request(w, ledger);
  w.setWorkspaces([{ branch: "feature/other", linkedPR: 8, path: ws }]);
  expect(
    (await tick(w)).repos[0]?.actions.some((a) => a.stage === "notify"),
  ).toBe(false);
  ageWait(w, "tree", 31);
  const report = (await tick(w)).repos[0];
  expect(report?.actions).toContainEqual(
    expect.objectContaining({
      stage: "notify",
      cause: "needs-person",
      reason: expect.stringContaining(
        "matching the stopped driver's actor and clone",
      ),
    }),
  );
  expect(report?.records).toContainEqual(
    expect.objectContaining({
      source: "PR #7 rearm request",
      ok: true,
      detail: expect.stringContaining("removed jig:rearm"),
    }),
  );
  const next = (await tick(w)).repos[0];
  expect(next?.actions.some((a) => a.evidence.rearm === true)).toBe(false);
  expect(next?.actions).toContainEqual(
    expect.objectContaining({
      stage: "notify",
      cause: "needs-person",
      reason: expect.stringContaining(
        "matching the stopped driver's actor and clone",
      ),
    }),
  );
  expect(driveRuns(w)).toEqual([]);
}, 90000);

it("removes a request from an earlier stop after a later drive converges", async () => {
  const { w, ledger } = fixture();
  request(w, ledger);
  const converged = stoppedLedger(7, DRIVE_EXIT.CONVERGED, {
    generation: ledger.generation + 1,
  });
  w.setComments(7, [ledgerComment(701, converged), requestFor(ledger)]);
  const report = (await tick(w)).repos[0];
  expect(report?.launches).toEqual([]);
  expect(report?.records).toContainEqual(
    expect.objectContaining({
      source: "PR #7 rearm request",
      ok: true,
      detail: expect.stringContaining("removed jig:rearm"),
    }),
  );
  expect(driveRuns(w)).toEqual([]);
}, 90000);

it("raises a bounded rearm failure when the named stop has moved to a newer stop", async () => {
  const { w, ledger } = fixture();
  ledger.driver.exit = DRIVE_EXIT.CI_INFRA_PERSISTED;
  request(w, ledger);
  const moved = { ...ledger, generation: ledger.generation + 1 };
  w.setComments(7, [ledgerComment(701, moved), requestFor(ledger)]);
  const reason =
    "the drive is no longer at the stop named by the rearm request";
  const first = (await tick(w)).repos[0];
  expect(
    first?.actions.some(
      (action) => action.stage === "notify" && action.reason.includes(reason),
    ),
  ).toBe(false);
  ageWait(w, "stop", 31);
  const retired = (await tick(w)).repos[0];
  expect(retired?.records).toContainEqual(
    expect.objectContaining({
      source: "PR #7 rearm request",
      ok: true,
      detail: `removed jig:rearm: ${reason}`,
    }),
  );
  for (const report of [retired, (await tick(w)).repos[0]]) {
    expect(report?.actions).toContainEqual(
      expect.objectContaining({
        stage: "notify",
        cause: "needs-person",
        reason: expect.stringContaining(reason),
      }),
    );
  }
  expect(driveRuns(w)).toEqual([]);
}, 90000);

it("retires requests on closed and merged pull requests", async () => {
  const { w, ledger } = fixture();
  request(w, ledger);
  w.setPrs("open", []);
  const labelled = { labels: [{ name: "jig:rearm" }] };
  w.setPrs("closed", [{ ...openPr(7, "feature/unclean"), ...labelled }]);
  w.setPrs("merged", [
    { ...mergedPr(8, "feature/merged", currentIso()), ...labelled },
  ]);
  const report = (await tick(w)).repos[0];
  for (const [pr, terminal] of [
    [7, "closed"],
    [8, "merged"],
  ]) {
    expect(report?.records).toContainEqual(
      expect.objectContaining({
        source: `PR #${pr} rearm request`,
        ok: true,
        detail: `removed jig:rearm: the pull request ${terminal}`,
      }),
    );
  }
  expect(driveRuns(w)).toEqual([]);
}, 90000);

it("keeps an aged rearm queued at capacity and gives it the next slot before an automatic retry", async () => {
  const { w, ledger } = fixture();
  ledger.driver.exit = DRIVE_EXIT.CI_INFRA_PERSISTED;
  request(w, ledger);
  const age = isoFromMs(currentMs() - 31 * 60_000);
  w.setComments(7, [ledgerComment(701, ledger), requestFor(ledger, 702, age)]);
  machineFile(w, [{ ...account(w, "a", "a@example.com"), max: 1 }]);
  const root = w.env.DRIVE_PR_STATE_DIR as string;
  holdLock(root, 99, join(w.root, "hand-tree"), "a@example.com");

  const full = (await tick(w)).repos[0];
  expect(full?.launches).toContainEqual(
    expect.objectContaining({
      target: "PR #7",
      outcome: "waits",
      detail: expect.stringContaining("no account has a free slot"),
    }),
  );
  expect(full?.actions.filter((action) => action.stage === "notify")).toEqual(
    [],
  );
  expect(
    full?.records.some((record) =>
      record.detail?.includes("removed jig:rearm"),
    ),
  ).toBe(false);

  ageWait(w, "capacity", 241);
  const aged = await tick(w);
  expect(
    aged.load?.holds.filter(
      (hold) => hold.target === "PR #7" && hold.detail.includes("4 hours"),
    ),
  ).toHaveLength(1);
  expect(
    aged.repos[0]?.actions.filter((action) => action.stage === "notify"),
  ).toEqual([]);

  endHolder(root, 99);
  const other = "feature/automatic";
  const otherTree = join(w.root, "automatic-tree");
  checkoutOn(w.repo, otherTree, other, w.env);
  const automatic = stoppedLedger(6, DRIVE_EXIT.NOT_SETTLED);
  w.setComments(6, [ledgerComment(601, automatic)]);
  w.setPrs("open", [
    openPr(6, other),
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
  w.setWorkspaces([
    { branch: other, linkedPR: 6, path: otherTree },
    {
      branch: "feature/unclean",
      linkedPR: 7,
      path: join(w.root, "original-dirty-tree"),
    },
  ]);
  const resumed = (await tick(w)).repos[0];
  const launches = resumed?.launches.filter(
    (launch) => launch.outcome === "launched",
  );
  expect(launches).toEqual([expect.objectContaining({ target: "PR #7" })]);
  expect(resumed?.launches).toContainEqual(
    expect.objectContaining({ target: "PR #6", outcome: "waits" }),
  );
  await waitFor("the queued rearm's exit", () =>
    exitWritten(w, launches?.[0]?.record ?? ""),
  );
}, 90000);

it("leaves a request cancelled if closing label cleanup fails and the pull request reopens", async () => {
  const { w, ledger } = fixture();
  ledger.driver.exit = DRIVE_EXIT.MAX_ROUNDS;
  request(w, ledger);
  const labelled = {
    ...openPr(7, "feature/unclean"),
    labels: [{ name: "jig:rearm" }],
  };
  w.setPrs("open", []);
  w.setPrs("closed", [labelled]);
  const failure = join(w.dir, "label-edit-fail");
  writeFileSync(failure, "refuse label writes");
  expect((await tick(w, 1)).repos[0]?.records).toContainEqual(
    expect.objectContaining({
      source: "PR #7 rearm request",
      ok: false,
    }),
  );
  rmSync(failure);
  w.setPrs("closed", []);
  w.setPrs("open", [labelled]);
  const report = (await tick(w)).repos[0];
  expect(report?.launches).toEqual([]);
  expect(report?.records).toContainEqual(
    expect.objectContaining({
      source: "PR #7 rearm request",
      ok: true,
      detail: expect.stringContaining("the pull request closed"),
    }),
  );
  expect(driveRuns(w)).toEqual([]);
}, 90000);
