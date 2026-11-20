/** A machine file that narrows an account's stages, as a tick reports and applies it. */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readLine } from "../lib/line-store.ts";
import { formatReceipt } from "../lib/report.ts";
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
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A stopped drive on PR #7 that the plan re-arms, and accounts with these stages. */
function fixture(narrow: string[], wide?: string[]) {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  machineFile(w, [
    { ...account(w, "narrow", "narrow@example.com"), stages: narrow },
    {
      ...account(w, "wide", "wide@example.com"),
      ...(wide === undefined ? {} : { stages: wide }),
    },
  ]);
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const path = join(w.root, "ws-7");
  mkdirSync(path);
  w.setWorkspaces([{ branch: "feature/7-parked", linkedPR: 7, path }]);
  return w;
}

async function tick(w: World, apply = false) {
  const result = await w.dispatch([...(apply ? ["--apply"] : []), "--json"]);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as TickReceipt;
}

it("reports, without --apply, the accounts each planned launch could use, and each account's stages", async () => {
  const w = fixture(["pickup", "followup"]);
  const receipt = await tick(w);
  expect(receipt.apply).toBe(false);
  expect(receipt.repos[0]?.actions).toContainEqual(
    expect.objectContaining({ stage: "rearm", target: "PR #7" }),
  );
  expect(receipt.stageAccounts).toEqual({
    pickup: ["narrow", "wide"],
    rearm: ["wide"],
    followup: ["narrow", "wide"],
    steward: ["wide"],
  });
  expect(receipt.accountWeights).toMatchObject([
    { account: "narrow", stages: ["pickup", "followup"] },
    { account: "wide" },
  ]);
  expect(receipt.accountWeights?.[1]?.stages).toBeUndefined();
  const text = formatReceipt(receipt, "fixture");
  expect(text).toMatch(
    /would rearm +PR #7[^\n]*(\n {8}evidence:[^\n]*)?\n {8}accounts: wide\n/,
  );
  expect(text).toContain("serves only pickup, followup");
  const line = readLine(dispatchState(w));
  expect(line.ok).toBe(true);
  if (line.ok)
    expect(line.value?.accounts.map((a) => a.stages)).toEqual([
      ["pickup", "followup"],
      undefined,
    ]);
});

it("reports that no account serves a planned launch's stage, and --apply leaves it waiting saying so", async () => {
  const w = fixture(["pickup"], ["followup"]);
  const dry = formatReceipt(await tick(w), "fixture");
  expect(dry).toContain("accounts: none, no account serves the rearm stage");
  const applied = await tick(w, true);
  const launch = applied.repos[0]?.launches[0];
  expect([launch?.action, launch?.outcome]).toEqual(["rearm", "waits"]);
  expect(launch?.detail).toContain("no account serves the rearm stage");
  expect(launch?.detail).not.toContain("no account has a free slot");
});

it("launches a re-arm on the account that serves rearm, past the turn", async () => {
  const w = fixture(["pickup", "followup"]);
  const applied = await tick(w, true);
  const launch = applied.repos[0]?.launches[0];
  expect(launch).toMatchObject({ outcome: "launched", account: "wide" });
  const id = launch?.record;
  expect(id).toBeString();
  if (typeof id === "string")
    await waitFor("the re-arm to finish", () => exitWritten(w, id));
});
