/**
 * dispatch --apply: a drive that stopped `CI_INFRA_PERSISTED` (`22`), every
 * failing check on its converged head having failed on the infrastructure
 * through its re-runs and head moves, is re-driven by a tick once its backoff
 * from the stop has passed, once per stop, on any account; a tick inside the
 * backoff launches nothing and tells no one. Each further stop the same way
 * waits longer, and a person is told only past the re-drive bound.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { DriveEvent } from "../../skills/drive-pr/scripts/lib/state/events.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { INFRA_REDRIVES } from "../lib/infra-backoff.ts";
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

const HEAD = "feature/7-infra";
const EXIT = DRIVE_EXIT.CI_INFRA_PERSISTED;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

/** A stop event `22`, `m` minutes ago. */
const infraStop = (m: number): DriveEvent => ({
  at: minutesAgo(m),
  round: 3,
  kind: "stop",
  cause: String(EXIT),
});

/** The ledger of a drive whose last stops were these. */
function stopped(events: DriveEvent[]): Ledger {
  const ledger = stoppedLedger(7, EXIT, { events });
  return {
    ...ledger,
    driver: { ...ledger.driver, heartbeat: events.at(-1)?.at ?? minutesAgo(0) },
  };
}

/** PR #7, its drive stopped as `ledger` says; its workspace exists, and account a may bill. */
function fixture(ledger: Ledger): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  w.setPrs("open", [openPr(7, HEAD, { mergeable: "MERGEABLE" })]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setComments(7, [ledgerComment(701, ledger)]);
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notified = (r: TickReceipt) =>
  (r.repos[0]?.notifications ?? []).map((n) => [n.target, n.cause, n.outcome]);

describe("jig dispatch --apply re-drives an infrastructure failure that persisted", () => {
  it("re-drives a stop 22 whose backoff has passed, and again after a later one", async () => {
    const first = infraStop(60);
    const w = fixture(stopped([first]));
    writeFileSync(join(w.dir, "drive-exit"), String(EXIT));
    const [launched] = launches(await tick(w));
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    const record = launched?.record ?? "";
    await waitFor("the exit", () => exitWritten(w, record));
    expect(readRecord(record, dispatchState(w))?.redrive).toMatchObject({
      cause: `stopped ${EXIT}, CI still failing on the infrastructure through its re-runs`,
      change: `head ${HEAD_SHA}, stopped ${EXIT} at ${first.at}`,
      mechanicalStop: "ci-infra",
    });

    // The re-drive stopped the same way: a new stop, re-driven once its longer
    // backoff has passed, not handed to a person.
    const second = infraStop(40);
    w.setComments(7, [ledgerComment(701, stopped([first, second]))]);
    const later = await tick(w);
    expect(launches(later)[0]).toMatchObject({
      action: "rearm",
      outcome: "launched",
    });
    expect(notified(later)).toEqual([]);
  }, 180_000);

  it("launches nothing and tells no one inside the backoff", async () => {
    const w = fixture(stopped([infraStop(1)]));
    const r = await tick(w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([]);
    const quiet = (r.repos[0]?.quiet ?? []).find((q) => q.target === "PR #7");
    expect(quiet?.why).toContain("its backoff ends");
  }, 90_000);

  it("tells a person once the stops outlast the re-drives", async () => {
    const stops = Array.from({ length: INFRA_REDRIVES + 1 }, () =>
      infraStop(24 * 60),
    );
    const w = fixture(stopped(stops));
    const r = await tick(w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(r.repos[0]?.actions[0]?.notice?.text).toContain(
      "the infrastructure has not recovered",
    );
  }, 90_000);
});
