/** Bounded recovery of a converged drive's uncommitted work in its original tree. */
import { afterEach, expect, it } from "bun:test";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { cloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import {
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
  waitFor,
} from "./launch-fixtures.ts";
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
  mkdirSync(ws, { recursive: true });
  const initialized = Bun.spawnSync(["git", "init", "-q", ws]);
  expectSpawnExit(
    {
      exitCode: initialized.exitCode,
      stdout: initialized.stdout.toString(),
      stderr: initialized.stderr.toString(),
    },
    0,
  );
  const ledger = stoppedLedger(7, 12);
  ledger.driver.clone = cloneId(cloneKey(join(ws, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  w.setComments(7, [ledgerComment(701, ledger)]);
  w.setWorkspaces(
    tree ? [{ branch: "feature/unclean", linkedPR: 7, path: ws }] : [],
  );
  machineFile(w, [account(w, "a", "a@example.com")]);
  return { w, ws };
}
async function tick(w: World) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
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

it("honors an explicit rearm request on a needs-person stop in the existing tree", async () => {
  const { w, ws } = fixture();
  w.setConfig(
    `dispatch:\n  labels: {enabled: true}\nissue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
  const ledger = stoppedLedger(7, 14);
  ledger.driver.clone = cloneId(cloneKey(join(ws, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  w.setComments(7, [ledgerComment(701, ledger)]);
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
  w.setPrs("open", [
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
  const again = await tick(w);
  expect(again.repos[0]?.launches[0]?.outcome).toBe("launched");
  await waitFor("the second explicit rearm exit", () =>
    exitWritten(w, again.repos[0]?.launches[0]?.record ?? ""),
  );
}, 90000);

it("retries a failed request-label removal without launching again", async () => {
  const { w } = fixture();
  w.setConfig(
    `dispatch:\n  labels: {enabled: true}\nissue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
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
  const { w, ws } = fixture();
  const ledger = stoppedLedger(7, 12);
  ledger.driver.clone = cloneId(cloneKey(join(ws, ".git")));
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
  ledger.driver.clone = `another-clone@${cloneId(cloneKey(join(ws, ".git")))
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
  ledger.driver.clone = cloneId(cloneKey(join(ws, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  w.setComments(7, [ledgerComment(701, ledger)]);
  const first = await tick(w);
  const id = first.repos[0]?.launches[0]?.record ?? "";
  expect(first.repos[0]?.launches[0]?.outcome).toBe("launched");
  await waitFor("the automatic recovery exit", () => exitWritten(w, id));
  w.setConfig(
    `dispatch:\n  labels: {enabled: true}\nissue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
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

it("tells a person when an explicit rearm of an exit 12 stop finds its tree gone", async () => {
  const { w } = fixture(false);
  w.setConfig(
    `dispatch:\n  labels: {enabled: true}\nissue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [
    { ...openPr(7, "feature/unclean"), labels: [{ name: "jig:rearm" }] },
  ]);
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
