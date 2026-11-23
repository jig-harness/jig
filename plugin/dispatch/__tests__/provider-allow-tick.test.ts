/** A repository's provider allow list as a tick reads and applies it: from the default branch, never a checkout. */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  world,
  type World,
} from "./fixtures.ts";
import {
  account,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A stopped drive on PR #7 the plan re-arms on a Claude subscription account, and the default branch's allow list. */
function fixture(allowed: string[], branchConfig?: string) {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  allowed_providers: [${allowed.join(", ")}]\n`,
  );
  machineFile(w, [account(w, "work", "work@example.com")]);
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const path = join(w.root, "ws-7");
  mkdirSync(path);
  w.setWorkspaces([{ branch: "feature/7-parked", linkedPR: 7, path }]);
  // The pull request's own branch, checked out in its workspace, carries a list of its own, committed and published.
  if (branchConfig !== undefined) {
    mkdirSync(join(path, ".config"), { recursive: true });
    writeFileSync(join(path, ".config", "jig.yaml"), branchConfig);
    const git = (...args: string[]) =>
      Bun.spawnSync(
        [
          "git",
          "-C",
          path,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    expectSpawnExit(git("add", ".config/jig.yaml"), 0);
    expectSpawnExit(git("commit", "-q", "-m", "widen the allow list"), 0);
    expectSpawnExit(
      git("push", "-q", "-f", "origin", "HEAD:feature/7-parked"),
      0,
    );
  }
  return w;
}

async function apply(w: World) {
  const result = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as TickReceipt;
}

it("refuses a launch the default branch's list does not allow, though the checkout's list widens it", async () => {
  const w = fixture(["openrouter"]);
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  writeFileSync(
    join(w.repo, ".config", "jig.yaml"),
    "dispatch:\n  allowed_providers: [anthropic, openrouter]\n",
  );
  const receipt = await apply(w);
  const launch = receipt.repos[0]?.launches[0];
  expect([launch?.action, launch?.outcome, launch?.record]).toEqual([
    "rearm",
    "waits",
    null,
  ]);
  expect(launch?.detail).toStartWith(`provider-not-allowed: ${SLUG}`);
  expect(launch?.detail).toContain(
    "the provider anthropic of the account work",
  );
});

it("refuses a launch the default branch's list does not allow, though the pull request's branch widens it", async () => {
  const w = fixture(
    ["openrouter"],
    "dispatch:\n  allowed_providers: [anthropic, openrouter]\n",
  );
  const receipt = await apply(w);
  const launch = receipt.repos[0]?.launches[0];
  expect([launch?.action, launch?.outcome, launch?.record]).toEqual([
    "rearm",
    "waits",
    null,
  ]);
  expect(launch?.detail).toStartWith(`provider-not-allowed: ${SLUG}`);
});

it("launches when the default branch's list names the account's provider", async () => {
  const w = fixture(["anthropic"]);
  const receipt = await apply(w);
  const launch = receipt.repos[0]?.launches[0];
  expect(launch).toMatchObject({ outcome: "launched", account: "work" });
  const id = launch?.record;
  expect(typeof id).toBe("string");
  if (typeof id === "string")
    await waitFor("the re-arm to finish", () => exitWritten(w, id));
});
