/**
 * dispatch --apply: a drive that stopped `FORGE_RATE_LIMITED` (`24`), the
 * forge's rate limit for its credential spent with a reset further off than
 * the drive waits, is not re-driven before the reset its stop recorded, and
 * is re-driven after it, on any account, without telling a person.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { DriveEvent } from "../../skills/drive-pr/scripts/lib/state/events.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { FORGE_LIMIT_FALLBACK_MS } from "../lib/forge-limit-redrive.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
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

const HEAD = "feature/7-limit";
const EXIT = DRIVE_EXIT.FORGE_RATE_LIMITED;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

const minutesFromNow = (m: number) => isoFromMs(currentMs() + m * 60_000);

/** A stop event `24`, `ago` minutes ago, its limit resetting `reset` minutes from now (none recorded when `null`). */
function limitStop(ago: number, reset: number | null): DriveEvent {
  return {
    at: minutesFromNow(-ago),
    round: 3,
    kind: "stop",
    cause: String(EXIT),
    ...(reset === null ? {} : { until: minutesFromNow(reset) }),
  };
}

/** The ledger of a drive whose last stop was `stop`. */
function stopped(stop: DriveEvent): Ledger {
  const ledger = stoppedLedger(7, EXIT, { events: [stop] });
  return { ...ledger, driver: { ...ledger.driver, heartbeat: stop.at } };
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
const quietWhy = (r: TickReceipt) =>
  (r.repos[0]?.quiet ?? []).find((q) => q.target === "PR #7")?.why ?? "";

describe("jig dispatch --apply re-drives a stop on the forge's rate limit", () => {
  it("launches nothing and tells no one before the reset its stop recorded", async () => {
    const stop = limitStop(5, 30);
    const r = await tick(fixture(stopped(stop)));
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([]);
    expect(quietWhy(r)).toContain(
      `the forge's rate limit resets ${stop.until ?? ""}`,
    );
  }, 90_000);

  it("re-drives it once the reset has passed, on any account, as the limit's re-drive", async () => {
    const stop = limitStop(40, -1);
    const w = fixture(stopped(stop));
    writeFileSync(join(w.dir, "drive-exit"), "0");
    const r = await tick(w);
    const [launched] = launches(r);
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    expect(notified(r)).toEqual([]);
    const record = launched?.record ?? "";
    await waitFor("the exit", () => exitWritten(w, record));
    expect(readRecord(record, dispatchState(w))?.redrive).toMatchObject({
      cause: `stopped ${EXIT}, the forge's rate limit for its credential spent`,
      change: `head ${HEAD_SHA}, stopped ${EXIT} at ${stop.at}`,
      mechanicalStop: "forge-limit",
    });
  }, 180_000);

  it("waits an hour after a stop that recorded no reset", async () => {
    const stop = limitStop(5, null);
    const r = await tick(fixture(stopped(stop)));
    expect(launches(r)).toEqual([]);
    const fallback = isoFromMs(parseMs(stop.at) + FORGE_LIMIT_FALLBACK_MS);
    expect(quietWhy(r)).toContain(`the forge's rate limit resets ${fallback}`);
  }, 90_000);
});
