import { afterEach, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { existingStateDb } from "../lib/state.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  withOrigin(w);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n  labels: { enabled: true }\n  adopt: { enabled: true }\n`,
  );
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const result = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as TickReceipt;
}

it.each([
  { slots: 8, starts: 3, reason: "per-tick budget" },
  { slots: 1, starts: 1, reason: "no account has a free slot" },
])(
  "fills available capacity and still opens notices: %j",
  async ({ slots, starts, reason }) => {
    const w = fixture();
    machineFile(
      w,
      [{ ...account(w, "a", "a@example.com"), max: slots }],
      { opens_per_tick: 4 },
      ["rearm", "notify"],
    );
    w.setPrs(
      "open",
      [1, 2, 3, 4, 5, 99].map((n) => openPr(n, `feature/${n}`)),
    );
    for (const n of [1, 2, 3, 4, 5])
      w.setComments(n, [ledgerComment(n * 1000, stoppedLedger(n, 16))]);
    w.setComments(99, [
      ledgerComment(
        99000,
        stoppedLedger(99, 8, {
          parked: [
            {
              key: "F1",
              kind: "finding",
              reason: "Choose the retry limit",
              round: 1,
              at: new Date().toISOString(),
              class: "design-choice",
              record: "Choose the retry limit",
            },
          ],
        }),
      ),
    ]);
    const receipt = await tick(w);
    const report = receipt.repos[0];
    expect(
      report?.launches.filter((l) => l.outcome === "launched"),
    ).toHaveLength(starts);
    expect(
      report?.launches
        .filter((l) => l.outcome === "waits")
        .every((l) => l.detail.includes(reason)),
    ).toBe(true);
    expect(report?.notifications.some((n) => n.outcome === "sent")).toBe(true);
    const calls = readFileSync(join(w.dir, "orca-calls.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s) as string[]);
    expect(
      calls.filter((c) => c[0] === "worktree" && c[1] === "create"),
    ).toHaveLength(starts + 1);
    const row = existingStateDb(dispatchState(w))
      ?.query("SELECT line FROM tick_line WHERE id = 1")
      .get() as { line: string };
    const line = JSON.parse(row.line) as LineSnapshot;
    const waiting = report?.launches.filter((l) => l.outcome === "waits") ?? [];
    expect(waiting.length).toBeGreaterThan(0);
    for (const launch of waiting)
      expect(
        line.queue.find((q) => q.target === launch.target)?.launch?.detail,
      ).toBe(launch.detail);
  },
  30_000,
);

it("starts an adoption within two ticks despite ten follow-ups, even with only one launch open per tick", async () => {
  const w = fixture();
  machineFile(
    w,
    [{ ...account(w, "a", "a@example.com"), max: 20 }],
    { opens_per_tick: 2 },
    ["rearm", "followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  w.setPrs(
    "merged",
    Array.from({ length: 10 }, (_, i) =>
      mergedPr(i + 1, `merged/${i}`, "2026-10-31T12:00:00Z"),
    ),
  );
  for (let n = 1; n <= 10; n++) w.setComments(n, []);
  w.setPrs("open", [
    {
      ...openPr(99, "feature/99"),
      author: { login: "drive-bot", is_bot: false },
      updatedAt: new Date().toISOString(),
    },
  ]);
  w.setComments(99, []);
  const receipts = [await tick(w), await tick(w)];
  for (const r of receipts)
    expect(
      r.repos
        .flatMap((repo) => repo.launches)
        .filter((l) => l.outcome === "launched").length,
    ).toBeLessThanOrEqual(1);
  expect(
    receipts
      .flatMap((r) => r.repos.flatMap((repo) => repo.launches))
      .some((l) => l.target === "PR #99" && l.outcome === "launched"),
  ).toBe(true);
}, 30_000);
