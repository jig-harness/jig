/**
 * A follow-up whose pass found an arm still pending records
 * `waits --reason pending`: the tick holds it until the time it named and
 * starts it again, never as a rate limit, and hands it to a person once
 * `dispatch.followup_within` has passed since the first pass that found the
 * arm pending. A follow-up stage with no `dispatch.followup_command` runs
 * the plugin's own follow-up skill, and a repository whose follow-up stage
 * is off reads no merged pull request for a default it does not use.
 */
import { afterEach, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitStreak, waitWords } from "../lib/followup-waits.ts";
import { type ReadRecord, readRecord } from "../lib/launches.ts";
import { DEFAULT_FOLLOWUP_COMMAND } from "../lib/section.ts";
import { followupPassArgv } from "../lib/session.ts";
import { stateDb } from "../lib/state.ts";
import type { WaitFor } from "../lib/wait-for.ts";
import { resultMain } from "../result.ts";
import type { World } from "./fixtures.ts";
import { SLUG, world } from "./fixtures.ts";
import {
  followupWorkspace,
  launches,
  markers,
  notices,
  passWaits,
  released as releasedWith,
} from "./followup-fixtures.ts";
import {
  account,
  dispatchState,
  earlierRecord,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  followupWorkspace(w);
  return w;
}

const ARM = "release: the release run is still going";

/** Launch the follow-up and let its pass record a pending wait until `until`, then exit; its launch record. */
const pending = (w: World, until: string): Promise<string> =>
  passWaits(w, ["--until", until, "--reason", "pending", "--arm", ARM]);

/** The tick after a wait's time: it starts nothing, deletes the marker, and asks no person. */
const released = (w: World, id: string): Promise<void> =>
  releasedWith(
    w,
    `launch record ${id}'s pass found the arm ${ARM} still pending`,
  );

/** Move a launch record's launch back by `ms`, as if its pass had started that long ago. */
function launchedEarlier(w: World, id: string, ms: number): void {
  const at = isoFromMs(currentMs() - ms);
  stateDb(dispatchState(w))
    .query(
      "UPDATE launches SET created_at = ?, record = json_set(record, '$.createdAt', ?) WHERE id = ?",
    )
    .run(at, at, id);
}

it("holds a follow-up whose arm is still pending until the time it named, never as a rate limit, and starts it again as a first run", async () => {
  const w = fixture();
  const until = isoFromMs(currentMs() + 3_600_000);
  const first = await pending(w, until);
  // The wrapper did not answer the marker: another host reads no failure.
  expect(markers(w)).toHaveLength(1);
  expect(markers(w)[0]?.body).not.toContain("outcome: failed");

  const before = await applyTick(w, false);
  expect(launches(before)).toEqual([]);
  expect(notices(before)).toEqual([]);
  const held = before.repos[0]?.running.find((r) => r.target === "PR #9");
  expect(held?.reason).toContain(`waits until ${until}`);
  expect(held?.reason).toContain(`the arm ${ARM} still pending`);
  expect(held?.reason).not.toContain("rate limit");

  stateDb(dispatchState(w))
    .query("UPDATE launches SET result_until = ? WHERE id = ?")
    .run(isoFromMs(currentMs() - 1000), first);
  await released(w, first);

  const runs = claudeRuns(w).length;
  const [again] = launches(await applyTick(w, false));
  expect(again).toMatchObject({ action: "followup", outcome: "launched" });
  await waitFor("the run after the wait", () => claudeRuns(w).length > runs);
  const record = readRecord(String(again?.record), dispatchState(w));
  expect(record?.facts.startsWith("recovery: ")).toBe(false);
}, 240_000);

it("hands a follow-up to a person, naming the pending arm, once followup_within has passed since its first pending wait", async () => {
  const w = fixture();
  const past = () => isoFromMs(currentMs() - 1000);
  const first = await pending(w, past());
  await released(w, first);
  // The first pass found the arm pending two hours ago, past the default hour.
  launchedEarlier(w, first, 2 * 3_600_000);
  const second = await pending(w, past());

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  const notice = notices(after).find((n) => n.target === "PR #9");
  expect(notice).toMatchObject({ cause: "followup-failed" });
  expect(notice?.reason).toContain(
    `its pass under launch record ${second} found the arm ${ARM} still pending`,
  );
  expect(notice?.reason).toContain("dispatch.followup_within 1h");
  expect(notice?.reason).not.toContain("rate limit");
  expect(claudeRuns(w)).toHaveLength(2);
}, 360_000);

/** An ended follow-up of PR #9 on `base`'s fields, launched at `at`, that recorded `waits` for `wait`. */
function waited(
  base: ReadRecord["record"],
  at: string,
  wait: WaitFor,
): ReadRecord {
  return {
    record: {
      ...base,
      id: `${at.replace(/[-:.]/g, "")}-eeeeeeee`,
      createdAt: at,
    },
    state: {
      kind: "ended",
      exit: { at, code: 0, signal: null },
      process: null,
    },
    result: "waits",
    waitsUntil: "2026-11-01T00:00:00.000Z",
    waitsFor: wait,
  };
}

it("counts pending waits apart from rate-limit waits", () => {
  const w = world();
  current = w;
  const base = earlierRecord(w, {
    id: "20261031T100000Z-aaaaaaaa",
    account: "a",
    action: "followup",
    pr: 9,
    repo: SLUG,
  });
  const rate: WaitFor = { reason: "rate-limit" };
  const arm: WaitFor = { reason: "pending", arm: "deploy" };
  const at = (m: number) =>
    `2026-10-31T11:${String(m).padStart(2, "0")}:00.000Z`;
  // Two rate-limit waits around three pending ones: not yet the third rate-limit wait.
  const mixed = [
    waited(base, at(0), rate),
    waited(base, at(10), arm),
    waited(base, at(20), arm),
    waited(base, at(30), arm),
    waited(base, at(40), rate),
  ];
  expect(waitStreak(mixed, SLUG, 9)).toMatchObject({
    count: 2,
    spent: false,
    pendingSince: at(10),
  });
  // The third rate-limit wait is a person's, the pending ones between them notwithstanding.
  const third = [...mixed, waited(base, at(50), rate)];
  expect(waitStreak(third, SLUG, 9)).toMatchObject({ count: 3, spent: true });
  // Pending waits alone, inside the hour: held, and never worded as a rate limit.
  const held = waitStreak(mixed.slice(1, 4), SLUG, 9);
  expect(held).toMatchObject({ count: 0, spent: false });
  expect(waitWords(held ?? ({} as never))).not.toContain("rate limit");
  // A pending wait launched an hour after the first is a person's.
  const late = [
    ...mixed.slice(1, 4),
    waited(base, "2026-10-31T12:10:00.000Z", arm),
  ];
  expect(waitStreak(late, SLUG, 9)).toMatchObject({ spent: true });
});

it("reads a waits result with no --reason as a rate limit's, and refuses a pending wait on a pickup", () => {
  const w = world();
  current = w;
  const until = isoFromMs(currentMs() + 10 * 60_000);
  const row = (id: string) =>
    stateDb(dispatchState(w))
      .query(
        "SELECT result, result_until, result_wait FROM launches WHERE id = ?",
      )
      .get(id);
  const plain = "20261110T120000Z-aaaaaaaa";
  earlierRecord(w, { id: plain, account: "a", action: "followup", pr: 9 });
  expect(
    resultMain(
      [plain, "earlier-token", "waits", "--until", until],
      dispatchState(w),
    ),
  ).toBe(0);
  expect(row(plain)).toEqual({
    result: "failed",
    result_until: until,
    result_wait: JSON.stringify({ reason: "rate-limit" }),
  });

  const armed = "20261110T120100Z-bbbbbbbb";
  earlierRecord(w, { id: armed, account: "a", action: "followup", pr: 9 });
  expect(
    resultMain(
      [
        armed,
        "earlier-token",
        "waits",
        "--reason",
        "pending",
        "--until",
        until,
        "--arm",
        "deploy",
      ],
      dispatchState(w),
    ),
  ).toBe(0);
  expect(row(armed)).toMatchObject({
    result_wait: JSON.stringify({ reason: "pending", arm: "deploy" }),
  });

  // An arm on a rate limit's wait, a pending wait with no arm, or a reason the command does not know, is refused.
  const refused = "20261110T120200Z-cccccccc";
  earlierRecord(w, { id: refused, account: "a", action: "followup", pr: 9 });
  for (const extra of [
    ["--arm", "deploy"],
    ["--reason", "later"],
    ["--reason", "pending"],
  ])
    expect(
      resultMain(
        [refused, "earlier-token", "waits", "--until", until, ...extra],
        dispatchState(w),
      ),
    ).toBe(2);

  const pickup = "20261110T120300Z-dddddddd";
  earlierRecord(w, {
    id: pickup,
    account: "a",
    action: "pickup",
    pr: null,
    item: "#12",
  });
  expect(
    resultMain(
      [
        pickup,
        "earlier-token",
        "waits",
        "--until",
        until,
        "--reason",
        "pending",
      ],
      dispatchState(w),
    ),
  ).toBe(2);
  expect(row(pickup)).toMatchObject({ result: null });
});

it("tells a follow-up's pass how to record an arm still pending", () => {
  const w = world();
  current = w;
  const record = earlierRecord(w, {
    id: "20261110T120400Z-eeeeeeee",
    account: "a",
    action: "followup",
    pr: 9,
    command: "/followup",
    marker: 901,
  });
  const prompt = followupPassArgv(record, []).at(-1) ?? "";
  expect(prompt).toContain(
    `dispatch result ${record.id} earlier-token waits --until <when to look again> --reason pending --arm`,
  );
  expect(prompt).toContain("dispatch.followup_within");
});

/** The forge's listings of merged pull requests among the calls the fake answered. */
function mergedListings(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((c) => c.includes("merged:>="));
}

/** A repository whose configuration names no follow-up command, on a host running `stages`. */
function noCommand(stages: string[]): World {
  const w = fixture();
  w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`);
  machineFile(w, [account(w, "a", "a@example.com")], {}, stages, {
    followup_since: "2026-10-30T00:00:00Z",
  });
  return w;
}

it("runs the plugin's follow-up skill where the follow-up stage is on and the repository names no command", async () => {
  const w = noCommand(["followup", "notify"]);
  const [launched] = launches(await applyTick(w, false));
  expect(launched).toMatchObject({ action: "followup", outcome: "launched" });
  const record = readRecord(String(launched?.record), dispatchState(w));
  expect(record?.command).toBe(DEFAULT_FOLLOWUP_COMMAND);
  await waitFor("the pass", () => claudeRuns(w).length === 1);
  expect(claudeRuns(w)[0]?.argv.at(-1)).toContain("/jig:followup 9");
  expect(mergedListings(w).length).toBeGreaterThan(0);
}, 240_000);

it("reads no merged pull request where the follow-up stage is off and the repository names no command", async () => {
  const w = noCommand(["rearm", "notify"]);
  const r = await applyTick(w, false);
  expect(launches(r)).toEqual([]);
  expect(mergedListings(w)).toEqual([]);
  expect(r.repos[0]?.records).toContainEqual(
    expect.objectContaining({
      record: "forge",
      ok: true,
      detail: expect.stringContaining(
        "the follow-up stage is off on this host: no follow-ups",
      ),
    }),
  );
}, 240_000);
