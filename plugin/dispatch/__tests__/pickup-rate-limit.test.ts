/**
 * A pickup the tracker's rate limit stopped: its pass records `waits` with
 * the reset, the item is held until then with no question for a person, and
 * the first tick after the reset may launch it again. A launch whose fresh
 * read the limit refuses waits rather than fails.
 */
import { afterEach, expect, it } from "bun:test";
import { pickupHold } from "../lib/actions/pickup-hold.ts";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  newRecordId,
  readEnded,
  readResult,
  recordExit,
} from "../lib/launches.ts";
import { freshServedPickup } from "../lib/sources/served.ts";
import { resultMain } from "../result.ts";
import { TrackerRateLimited } from "../../shared/tracker-budget.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";
import { world, type World } from "./fixtures.ts";

const LIMITED = newRecordId(new Date("2026-11-10T11:00:00.000Z"));
const PICKUP = newRecordId(new Date("2026-11-10T11:01:00.000Z"));
const FOLLOWUP = newRecordId(new Date("2026-11-10T11:02:00.000Z"));
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

it("holds a pickup that waits on the rate limit until the reset, then lets it start again", () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  earlierRecord(w, {
    id: LIMITED,
    account: "a",
    action: "pickup",
    pr: null,
    item: "ENG-4",
  });
  recordExit(
    LIMITED,
    {
      at: "2026-11-10T12:00:00.000Z",
      code: 0,
      signal: null,
      said: "Question: should the dispatcher retry after the reset?",
    } as Parameters<typeof recordExit>[1],
    root,
  );
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  expect(
    resultMain([LIMITED, "earlier-token", "waits", "--until", until], root),
  ).toBe(0);
  const ended = readEnded(LIMITED, root);
  expect(ended?.result).toBe("waits");
  expect(ended?.waitsUntil).toBe(until);
  if (ended === null) return;
  const before = pickupHold("ENG-4", [ended], undefined, Date.parse(until) - 1);
  expect(before.kind).toBe("held");
  expect(before.kind === "held" && before.why).toContain(
    `waits for the tracker's rate limit to reset at ${until}`,
  );
  expect(
    pickupHold("ENG-4", [ended], undefined, Date.parse(until) + 1),
  ).toEqual({
    kind: "none",
  });
});

it("takes a waits result through the jig command line", () => {
  const w = world();
  current = w;
  earlierRecord(w, {
    id: PICKUP,
    account: "a",
    action: "pickup",
    pr: null,
    item: "ENG-6",
  });
  const until = new Date(Date.now() + 10 * 60_000).toISOString();
  const plugin = join(import.meta.dir, "..", "..");
  const run = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(plugin, "dispatch", "bunfig.toml")}`,
      join(plugin, "jig.ts"),
      "dispatch",
      "result",
      PICKUP,
      "earlier-token",
      "waits",
      "--until",
      until,
    ],
    { env: { ...process.env, HOME: w.home }, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(run, 0);
  expect(JSON.parse(run.stdout.toString())).toMatchObject({
    result: "waits",
    until,
  });
  expect(readResult(PICKUP, dispatchState(w))).toBe("waits");
});

it("refuses a waits result without a time, too far ahead, or on a follow-up's record", () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  earlierRecord(w, {
    id: PICKUP,
    account: "a",
    action: "pickup",
    pr: null,
    item: "ENG-5",
  });
  earlierRecord(w, { id: FOLLOWUP, account: "a", action: "followup", pr: 9 });
  const soon = new Date(Date.now() + 60_000).toISOString();
  const far = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
  expect(resultMain([PICKUP, "earlier-token", "waits"], root)).toBe(2);
  expect(
    resultMain([PICKUP, "earlier-token", "waits", "--until", far], root),
  ).toBe(2);
  expect(
    resultMain([FOLLOWUP, "earlier-token", "waits", "--until", soon], root),
  ).toBe(2);
});

it("answers a launch's fresh read with the limit, so the launch waits", async () => {
  const reset = Date.parse("2026-11-10T12:30:00.000Z");
  const tracker = {
    adapter: "linear",
    team: "ENG",
    poolIssue: async () => {
      throw new TrackerRateLimited("linear", reset, "RATELIMITED");
    },
  } as unknown as Tracker;
  const fresh = await freshServedPickup(tracker, "ENG-4", "person@example.com");
  expect(fresh).toContain("rate limit");
  expect(fresh).toContain(new Date(reset).toISOString());
});
