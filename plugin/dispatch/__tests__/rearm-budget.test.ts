/** A re-arm a person asked for grants a spent round budget; a mechanical re-drive does not. */
import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { cloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { currentIso } from "../../shared/time.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { REARM_REQUEST } from "../lib/rearm-binding.ts";
import { readRecord } from "../lib/launches.ts";
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

/** A drive of PR 7 stopped with `exit` in its original tree, with a rearm request when asked. */
function fixture(exit: number, requested: boolean) {
  const w = world();
  current = w;
  const labels = requested ? [{ name: "jig:rearm" }] : [];
  w.setConfig(
    `${requested ? "dispatch:\n  labels: {enabled: true}\n" : ""}issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  w.setPrs("open", [{ ...openPr(7, "feature/budget"), labels }]);
  const ws = join(w.root, "original-tree");
  checkoutOn(w.repo, ws, "feature/budget", w.env);
  const ledger = stoppedLedger(7, exit);
  ledger.driver.clone = cloneId(cloneKey(join(w.repo, ".git")));
  ledger.driver.actor = `wt-${worktreePathKey(ws)}`;
  w.setComments(7, [
    ledgerComment(701, ledger),
    ...(requested ? [requestFor(ledger)] : []),
  ]);
  w.setWorkspaces([{ branch: "feature/budget", linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")]);
  return w;
}

function requestFor(ledger: Ledger) {
  return forgeComment(
    702,
    claimBody(REARM_REQUEST, {
      key: "rearm",
      generation: ledger.generation,
      writer: localWriter("forge", "maintainer"),
      at: currentIso(),
      payload: { label: "jig:rearm", stopComment: 701 },
      text: "",
    }),
    "maintainer",
    "MEMBER",
  );
}

async function launched(w: World) {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  const receipt = JSON.parse(r.stdout) as TickReceipt;
  const launch = receipt.repos[0]?.launches[0];
  expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the drive's exit", () => exitWritten(w, launch?.record ?? ""));
  return readRecord(launch?.record ?? "", dispatchState(w));
}

it("passes --rearm-budget to the drive a person re-armed after MAX_ROUNDS", async () => {
  const w = fixture(DRIVE_EXIT.MAX_ROUNDS, true);
  const record = await launched(w);
  expect(record?.rearm).toBe(true);
  expect(driveRuns(w)[0]?.argv).toContain("--rearm-budget");
});

it("grants no budget to a re-drive no one asked for", async () => {
  const w = fixture(DRIVE_EXIT.WORKTREE_UNCLEAN, false);
  const record = await launched(w);
  expect(record?.rearm).toBeUndefined();
  expect(driveRuns(w)[0]?.argv).not.toContain("--rearm-budget");
});
