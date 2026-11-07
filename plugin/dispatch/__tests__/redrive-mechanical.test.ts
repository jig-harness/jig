/**
 * dispatch --apply: a drive that stopped on a cause its own next step
 * settles, a stall (`14`) or CI still red with its repair passes spent
 * (`21`), is re-armed once per head commit, on any account; a person is told
 * once a re-drive leaves the same stop at the same head, and a head that
 * moves is a new attempt. A stall that left work in its tree is re-driven in
 * that tree, never in a fresh one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { hostLabel } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { readRecord } from "../lib/launches.ts";
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
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const HEAD = "feature/7-stalled";
const MOVED = "b".repeat(40);

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** The ledger as a drive that just stopped `exit` wrote it, its heartbeat now. */
function stop(
  exit: number,
  generation: number,
  extra: Partial<Ledger> = {},
): Ledger {
  const ledger = stoppedLedger(7, exit, extra);
  return {
    ...ledger,
    generation,
    driver: {
      ...ledger.driver,
      heartbeat: new Date().toISOString(),
      ...extra.driver,
    },
  };
}

/** PR #7, whose drive stopped `ledger`'s way, as the forge now lists it; its workspace exists, and account a may bill. */
function fixture(
  pr: { headRefOid?: string; mergeable?: string },
  ledger: (ws: string) => Ledger,
): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  w.setPrs("open", [openPr(7, HEAD, pr)]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setComments(7, [ledgerComment(701, ledger(ws))]);
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return { w, ws };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notified = (r: TickReceipt) =>
  (r.repos[0]?.notifications ?? []).map((n) => [n.target, n.cause, n.outcome]);

/** Run one tick that re-drives PR #7, its drive exiting `driveExit`; wait for the exit. */
async function redrive(w: World, driveExit: number): Promise<string> {
  writeFileSync(join(w.dir, "drive-exit"), String(driveExit));
  const [launched] = launches(await tick(w));
  expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  const record = launched?.record ?? "";
  await waitFor("the exit", () => exitWritten(w, record));
  return record;
}

describe("jig dispatch --apply re-drives a stall and a spent CI-repair budget", () => {
  for (const [exit, kind, words] of [
    [14, "stall", "stalled"],
    [21, "ci-repair", "CI still failing with its repair passes spent"],
  ] as const) {
    it(`re-arms a stop ${exit} once per head, then tells a person, saying when the pull request conflicts`, async () => {
      const { w } = fixture({ mergeable: "CONFLICTING" }, () =>
        stop(exit, 3, {
          events: [
            {
              at: new Date().toISOString(),
              round: 3,
              kind: "stop",
              cause: String(exit),
              leftWork: false,
            },
          ],
        }),
      );
      const record = await redrive(w, exit);
      expect(readRecord(record, dispatchState(w))?.redrive).toEqual({
        cause: `stopped ${exit}, ${words}`,
        change: `head ${HEAD_SHA}, stopped ${exit}`,
        mechanicalStop: kind,
      });
      w.setComments(7, [
        ledgerComment(
          701,
          stop(exit, 4, {
            events: [
              {
                at: new Date().toISOString(),
                round: 4,
                kind: "stop",
                cause: String(exit),
                leftWork: false,
              },
            ],
          }),
        ),
      ]);

      const second = await tick(w);
      expect(launches(second)).toEqual([]);
      expect(notified(second)).toEqual([["PR #7", "needs-person", "sent"]]);
      const text = second.repos[0]?.actions[0]?.notice?.text ?? "";
      expect(text).toContain(
        `launch record ${record} already re-drove it for this change and ended ${exit}: only a person settles it until its head moves`,
      );
      expect(text).toContain("also conflicts with its base");

      // A new head is a new attempt.
      w.setPrs("open", [
        openPr(7, HEAD, { headRefOid: MOVED, mergeable: "MERGEABLE" }),
      ]);
      const again = await redrive(w, exit);
      expect(readRecord(again, dispatchState(w))?.redrive?.change).toBe(
        `head ${MOVED}, stopped ${exit}`,
      );
      expect(driveRuns(w)).toHaveLength(2);
    }, 180_000);
  }

  it("keeps a generic exit 1 a person's", async () => {
    const { w } = fixture({ mergeable: "MERGEABLE" }, () => stop(1, 3));
    const r = await tick(w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([["PR #7", "needs-person", "sent"]]);
  }, 90_000);

  it("re-drives a stall that left work only in the tree it stalled in", async () => {
    const leftWork = (actor: (ws: string) => string) => (ws: string) =>
      stop(14, 3, {
        events: [
          {
            at: new Date().toISOString(),
            round: 3,
            kind: "stop",
            cause: "14",
            leftWork: true,
          },
        ],
        driver: {
          ...stoppedLedger(7, 14).driver,
          actor: actor(ws),
          clone: `clone-a@${hostLabel()}`,
        },
      });

    // The workspace is the stalled tree: the re-drive runs in it.
    const own = fixture(
      { mergeable: "MERGEABLE" },
      leftWork((ws) => `wt-${worktreePathKey(ws)}`),
    );
    const record = await redrive(own.w, 14);
    expect(readRecord(record, dispatchState(own.w))?.workspace?.path).toBe(
      own.ws,
    );
    current?.close();

    // No open workspace holds the stalled tree: a person recovers the work.
    const gone = fixture(
      { mergeable: "MERGEABLE" },
      leftWork(() => "wt-0123456789abcdef"),
    );
    const r = await tick(gone.w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(r.repos[0]?.actions[0]?.notice?.text).toContain(
      "which no open workspace on this host holds",
    );
  }, 180_000);
});
