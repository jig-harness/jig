/**
 * dispatch --apply: a drive runs in a workspace it did not open (the one
 * joined to the pull request, a pending launch's recorded workspace
 * replayed) only once that workspace is proven to be the pull request's
 * checkout; otherwise nothing runs in it and its work stays where it is.
 */
import { afterEach, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  checkoutOn,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  driveRuns,
  machineFile,
  recordIds,
  terminalCreates,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const HEAD = "feature/7-parked";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A quota-parked PR #7 whose joined workspace is a checkout of the clone on its branch. */
function fixture(): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  withOrigin(w);
  w.setPrs("open", [openPr(7, HEAD)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const ws = join(w.root, "ws-7");
  checkoutOn(w.repo, ws, HEAD, w.env);
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  return { w, ws };
}

/** Move the workspace onto a commit of another history, as a stale checkout of an earlier branch of the same name is, with work it has not saved. */
function staleWithWork(w: World, ws: string): void {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", ws, ...args], {
      env: w.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    return r.stdout.toString().trim();
  };
  const tree = git("rev-parse", "HEAD^{tree}");
  const stale = git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit-tree",
    tree,
    "-m",
    "an earlier branch",
  );
  git("checkout", "-q", "--detach", stale);
  writeFileSync(join(ws, "unsaved.txt"), "unsaved work\n");
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

it("refuses a joined workspace left on another history, runs nothing in it and keeps its work", async () => {
  const { w, ws } = fixture();
  machineFile(w, [account(w, "a", "a@example.com")]);
  staleWithWork(w, ws);
  const [refused] = launches(await tick(w));
  expect(refused?.outcome).toBe("refused");
  expect(refused?.detail).toContain(
    `the workspace ${ws} is not proven to be PR #7's checkout, so nothing runs in it and its work stays as it is`,
  );
  expect(refused?.detail).toContain("neither the pull request head");
  expect(terminalCreates(w)).toEqual([]);
  expect(driveRuns(w)).toEqual([]);
  expect(recordIds(w)).toEqual([]);
  expect(readFileSync(join(ws, "unsaved.txt"), "utf8")).toBe("unsaved work\n");
});

it("replays a lost launch only once its workspace is proven again", async () => {
  const { w, ws } = fixture();
  machineFile(w, [account(w, "a", "a@example.com")], {
    runtime_timeout: "2s",
  });
  writeFileSync(join(w.dir, "orca-terminal-hang"), "");
  const first = launches(await tick(w))[0];
  expect(first?.outcome).toBe("lost");
  rmSync(join(w.dir, "orca-terminal-hang"));

  // Between the launch that got no answer and its replay, the workspace changed.
  staleWithWork(w, ws);
  const replay = launches(await tick(w));
  expect(replay.map((l) => l.outcome)).not.toContain("retried");
  expect(JSON.stringify(replay)).toContain(
    `the workspace ${ws} is not proven to be PR #7's checkout`,
  );
  expect(terminalCreates(w)).toHaveLength(1);
  expect(recordIds(w)).toEqual([first?.record ?? ""]);
  expect(readFileSync(join(ws, "unsaved.txt"), "utf8")).toBe("unsaved work\n");
});
