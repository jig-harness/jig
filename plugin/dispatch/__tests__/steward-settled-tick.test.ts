import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  claimStewardRecord,
  keepStewardRun,
  markStewardEffect,
  readStewardDigest,
  stewardRecords,
  submitStewardRecords,
  type StewardRecord,
} from "../lib/steward.ts";
import { stateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  world,
  openPr,
  ledgerComment,
  stoppedLedger,
  SLUG,
  type World,
} from "./fixtures.ts";
import { account, machineFile, dispatchState } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});
function fixture() {
  const w = world();
  current = w;
  w.setConfig(
    "issue_tracker:\n  adapter: github\ndispatch:\n  identity: factory-bot\n",
  );
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    { steward: { enabled: true, every: "20m" } },
    ["steward"],
  );
  return w;
}
async function tick(w: World) {
  const result = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as TickReceipt;
}
const need = (target: string): StewardRecord => ({
  kind: "need",
  target,
  act: "Reply",
  ask: "Choose the next step.",
  reason: "A person must choose.",
});
function keep(w: World, records: StewardRecord[]) {
  const root = dispatchState(w);
  keepStewardRun(
    "source",
    {
      version: 1,
      repo: SLUG,
      drives: [],
      needs: [],
      queue: [],
      passes: [],
      failures: [],
      load: null,
    },
    Date.now(),
    root,
  );
  expect(submitStewardRecords("source", records, root).ok).toBe(true);
  return root;
}

test("a refused need is unplaced once and stays quiet for subsequent ticks", async () => {
  const w = fixture();
  const root = keep(w, [need("#12")]);
  const first = await tick(w);
  expect(
    first.repos[0]?.unplaced.filter((u) =>
      u.target.startsWith("steward record "),
    ),
  ).toHaveLength(1);
  expect(stewardRecords(SLUG, root)[0]?.effect).toBe("refused");
  for (let n = 0; n < 2; n++)
    expect(
      (await tick(w)).repos[0]?.unplaced.filter((u) =>
        u.target.startsWith("steward record "),
      ),
    ).toEqual([]);
}, 60_000);

test("settled records do not read their stored digest and remain as witnesses", async () => {
  const w = fixture();
  const records: StewardRecord[] = Array.from({ length: 100 }, (_, n) => {
    switch (n % 4) {
      case 0:
        return need(`#${n + 1}`);
      case 1:
        return { kind: "resume", record: `pass-${n}`, reason: "resume" };
      case 2:
        return {
          kind: "facet",
          target: `#${n + 1}`,
          facet: "size",
          value: "small",
          reason: "size",
        };
      default:
        return {
          kind: "rearm",
          target: `PR #${n + 1}`,
          facts: "generation 1",
          class: "transient",
          reason: "retry",
        };
    }
  });
  const root = keep(w, records);
  for (const kept of stewardRecords(SLUG, root)) {
    expect(claimStewardRecord(kept.id, root)).toBe(true);
    if (kept.value.kind === "need") markStewardEffect(kept.id, "refused", root);
    if (kept.value.kind === "rearm")
      markStewardEffect(kept.id, "launched", root);
  }
  // A read of this invalid digest would produce an unplaced runtime error.
  stateDb(root)
    .query("UPDATE steward_runs SET digest = 'unreadable' WHERE id = 'source'")
    .run();
  expect(
    (await tick(w)).repos[0]?.unplaced.filter((u) =>
      u.target.startsWith("steward "),
    ),
  ).toEqual([]);
  expect(stewardRecords(SLUG, root)).toHaveLength(100);
}, 60_000);

test("an applied continuing need still projects its framing on later ticks", async () => {
  const w = fixture();
  w.setPrs("open", [openPr(7, "feature/stopped")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 2))]);
  w.setWorkspaces([{ branch: "feature/stopped", linkedPR: 7, path: w.repo }]);
  const first = await tick(w);
  const root = dispatchState(w);
  const row = stateDb(root)
    .query("SELECT id FROM steward_runs LIMIT 1")
    .get() as { id: string };
  const digest = readStewardDigest(row.id, root);
  expect(digest.ok).toBe(true);
  if (!digest.ok) return;
  expect(
    digest.value.needs.some((a) => a.target === "PR #7"),
    JSON.stringify(first.repos[0]),
  ).toBe(true);
  expect(submitStewardRecords(row.id, [need("PR #7")], root).ok).toBe(true);
  for (let n = 0; n < 2; n++) {
    const receipt = await tick(w);
    expect(
      receipt.repos[0]?.actions.find(
        (a) => a.stage === "notify" && a.target === "PR #7",
      )?.evidence.stewardAsk,
    ).toBe("Choose the next step.");
    expect(stewardRecords(SLUG, root)[0]?.applied).toBe(true);
  }
}, 60_000);
