/** The host-local file is re-read between actual ticks, and reaches the receipt and dashboard line. */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecord } from "../lib/launches.ts";
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
  terminalCreates,
} from "./launch-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});
function fixture(wanted = false) {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  machineFile(w, [
    account(w, "a", "a@example.com"),
    account(w, "b", "b@example.com"),
  ]);
  if (wanted) {
    w.setPrs("open", [openPr(7, "feature/7-parked")]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
    const path = join(w.root, "ws-7");
    mkdirSync(path);
    w.setWorkspaces([{ branch: "feature/7-parked", linkedPR: 7, path }]);
  }
  return w;
}
async function tick(w: World, apply = false) {
  const result = await w.dispatch([...(apply ? ["--apply"] : []), "--json"]);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as TickReceipt;
}
it("applies an edited local file on the very next tick and admits only the resumed account", async () => {
  const w = fixture(true);
  const path = join(w.home, ".jig", "weights.local.yaml");
  writeFileSync(path, "accounts: {a: 0, b: 0}\n");
  const first = await tick(w, true);
  expect(first.repos[0]?.launches[0]).toMatchObject({
    outcome: "waits",
    detail: expect.stringContaining("a weight 0"),
  });
  expect(first.accountWeights).toMatchObject([
    { account: "a", configured: 0, effective: 0 },
    { account: "b", configured: 0, effective: 0 },
  ]);
  writeFileSync(path, "accounts: {a: 0, b: 25}\n");
  const second = await tick(w, true);
  expect(second.repos[0]?.launches[0]).toMatchObject({
    outcome: "launched",
    account: "b",
  });
  expect(second.accountWeights).toMatchObject([
    { configured: 0, effective: 0 },
    { configured: 25, effective: 25 },
  ]);
  const line = readLine(dispatchState(w));
  expect(line.ok).toBe(true);
  if (line.ok)
    expect(line.value?.accounts.map((a) => a.weight)).toMatchObject([
      { configured: 0, effective: 0 },
      { configured: 25, effective: 25 },
    ]);
  const id = second.repos[0]?.launches[0]?.record;
  expect(id).toBeString();
  if (id !== undefined && id !== null) {
    expect(readRecord(id, dispatchState(w))?.accountLaunchOrdinal).toBe(1);
    await waitFor("the weighted launch to finish", () => exitWritten(w, id));
  }
});
it("reports bad files and unknown names even with no wanted launch, including terminal output and stored status", async () => {
  const w = fixture();
  const path = join(w.home, ".jig", "weights.local.yaml");
  for (const text of ["accounts: {missing: 50}", "accounts: ["]) {
    writeFileSync(path, text);
    const receipt = await tick(w);
    expect(receipt.accountWeights).toHaveLength(2);
    expect(
      receipt.accountWeights?.every(
        (a) =>
          a.configured === null &&
          a.effective === 0 &&
          a.reason.includes("weights.local.yaml"),
      ),
    ).toBe(true);
    expect(formatReceipt(receipt, "fixture")).toContain(
      "weight unreadable, effective 0",
    );
    const line = readLine(dispatchState(w));
    expect(line.ok).toBe(true);
    if (line.ok)
      expect(line.value?.accounts[0]?.weight).toMatchObject({
        configured: null,
        effective: 0,
      });
  }
});

it("does not replay a lost runtime launch after the account is paused or its weights cannot be read", async () => {
  const w = fixture(true);
  machineFile(w, [account(w, "a", "a@example.com")], { runtime_timeout: "2s" });
  const hang = join(w.dir, "orca-terminal-hang");
  writeFileSync(hang, "");
  const first = await tick(w, true);
  const pending = first.repos[0]?.launches[0];
  expect(pending?.outcome).toBe("lost");
  rmSync(hang);
  expect(terminalCreates(w)).toHaveLength(1);
  for (const text of ["accounts: {a: 0}", "accounts: ["]) {
    writeFileSync(join(w.home, ".jig", "weights.local.yaml"), text);
    const second = await tick(w, true);
    expect(second.repos[0]?.launches).toContainEqual(
      expect.objectContaining({
        outcome: "waits",
        record: pending?.record,
        detail: expect.stringContaining("weight"),
      }),
    );
    expect(terminalCreates(w)).toHaveLength(1);
  }
});
