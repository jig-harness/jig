/**
 * A follow-up whose pass met a rate limit records `waits` with the reset:
 * the tick holds it until then with no question for a person, releases its
 * marker once the reset has passed, and starts it again as a first run. The
 * third wait in a row is a person's, the rate limit named in the notice. A
 * pass that stopped on a question naming only a rate limit waits the same
 * way, and a person's restart starts the count again.
 */
import { afterEach, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { bootId } from "../../shared/liveness.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  FOLLOWUP_CLAIM,
  tickClaim,
} from "../../shared/records/launch-claims.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { waitEnd, waitStreak, waitUntil } from "../lib/followup-waits.ts";
import {
  claimRecord,
  type ReadRecord,
  readEnded,
  readRecord,
  recordExit,
} from "../lib/launches.ts";
import { followupPassArgv } from "../lib/session.ts";
import { stateDb } from "../lib/state.ts";
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
  dispatchState,
  earlierRecord,
  exitWritten,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";

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

/** Launch the follow-up and let its pass record `waits` until `until`, then exit; its launch record. */
const waits = (w: World, until: string): Promise<string> =>
  passWaits(w, ["--until", until]);

/** The tick after a wait's reset: it starts nothing, deletes the marker, and asks no person. */
const released = (w: World, id: string): Promise<void> =>
  releasedWith(w, `launch record ${id}'s pass met a rate limit`);

/** Move a wait's reset into the past, as if the time it named had come. */
function resetPassed(w: World, id: string): void {
  stateDb(dispatchState(w))
    .query("UPDATE launches SET result_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), id);
}

it("holds a follow-up that waits on a rate limit until the reset, releases its marker after it, and starts it again as a first run", async () => {
  const w = fixture();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const first = await waits(w, until);
  // The wrapper did not answer the marker: another host reads no failure.
  expect(markers(w)).toHaveLength(1);
  expect(markers(w)[0]?.body).not.toContain("outcome: failed");

  const before = await applyTick(w, false);
  expect(launches(before)).toEqual([]);
  expect(notices(before)).toEqual([]);
  expect(before.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(`waits until ${until}`),
    }),
  );
  expect(markers(w)).toHaveLength(1);
  expect(markers(w)[0]?.body).not.toContain("outcome: failed");

  resetPassed(w, first);
  await released(w, first);

  const runs = claudeRuns(w).length;
  const [again] = launches(await applyTick(w, false));
  expect(again).toMatchObject({ action: "followup", outcome: "launched" });
  await waitFor("the run after the reset", () => claudeRuns(w).length > runs);
  const record = readRecord(String(again?.record), dispatchState(w));
  expect(record?.facts.startsWith("recovery: ")).toBe(false);
  expect(markers(w)).toHaveLength(1);
}, 240_000);

it("hands a follow-up that waited three times in a row to a person, naming the rate limit, and counts again from one once the person deletes its marker", async () => {
  const w = fixture();
  const past = () => new Date(Date.now() - 1000).toISOString();
  await released(w, await waits(w, past()));
  await released(w, await waits(w, past()));
  const third = await waits(w, past());

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  expect(notices(after)).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      cause: "followup-failed",
      reason: expect.stringContaining(
        `its pass under launch record ${third} met the rate limit 3 times in a row`,
      ),
    }),
  );
  expect(markers(w)).toHaveLength(1);
  expect(claudeRuns(w)).toHaveLength(3);

  // The person deletes the marker: the next wait is the first of a new count.
  w.setComments(9, []);
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const fourth = await waits(w, until);
  const held = await applyTick(w, false);
  expect(launches(held)).toEqual([]);
  expect(notices(held)).toEqual([]);
  expect(held.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(
        `launch record ${fourth}'s pass met a rate limit and waits until ${until} (1 in a row;`,
      ),
    }),
  );
}, 480_000);

/** A question naming only the forge's rate limit, as a pass asks it. */
const RATE_LIMITED =
  "Question: the forge answered API rate limit exceeded for the release tag; wait for its reset or stop?";

it("holds a follow-up whose pass stopped on a rate-limit question as a wait, asking no person", async () => {
  const w = fixture();
  const runs = claudeRuns(w).length;
  const [launched] = launches(await applyTick(w, false));
  const id = String(launched?.record);
  await waitFor("the pass", () => claudeRuns(w).length === runs + 1);
  const record = readRecord(id, dispatchState(w));
  expectSpawnExit(
    await w.dispatch(["result", id, String(record?.token), "failed"]),
    0,
  );
  writeFileSync(join(w.dir, "claude-said"), `${RATE_LIMITED}\n`);
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("the exit", () => exitWritten(w, id));
  rmSync(join(w.dir, "claude-exit"));
  rmSync(join(w.dir, "claude-said"));
  // The wrapper did not answer the marker: another host reads no failure.
  expect(markers(w)[0]?.body).not.toContain("outcome: failed");

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  expect(notices(after)).toEqual([]);
  expect(after.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(
        `launch record ${id}'s pass met a rate limit and waits until`,
      ),
    }),
  );
  expect(markers(w)).toHaveLength(1);
}, 240_000);

const OLD = "20261031T130000Z-aaaaaaaa";

it("starts again a follow-up that ended on a rate-limit question before passes recorded waits, its marker answered failed", async () => {
  const w = fixture();
  earlierRecord(w, {
    id: OLD,
    account: "a",
    action: "followup",
    pr: 9,
    command: "/followup",
    marker: 902,
    facts: "merged 2026-10-31T12:00:00Z",
    createdAt: "2026-10-31T13:00:00.000Z",
  });
  claimRecord(
    OLD,
    {
      hostId: "",
      host: hostname(),
      bootId: bootId(),
      pid: 1,
      start: "x",
      claimedAt: "2026-10-31T13:00:00.000Z",
    },
    dispatchState(w),
  );
  recordExit(
    OLD,
    {
      at: "2026-10-31T13:05:00.000Z",
      code: 0,
      signal: null,
      said: RATE_LIMITED,
    },
    dispatchState(w),
  );
  w.setComments(9, [
    forgeComment(
      902,
      claimBody(
        FOLLOWUP_CLAIM,
        tickClaim(
          OLD,
          { pr: 9, writer: { host: "sha256:0123456789abcdef" } },
          "failed",
        ),
      ),
      "drive-bot",
    ),
  ]);

  await released(w, OLD);
  const runs = claudeRuns(w).length;
  const [again] = launches(await applyTick(w, false));
  expect(again).toMatchObject({ action: "followup", outcome: "launched" });
  await waitFor("the run after the reset", () => claudeRuns(w).length > runs);
  const record = readRecord(String(again?.record), dispatchState(w));
  expect(record?.facts.startsWith("recovery: ")).toBe(false);
}, 240_000);

/** An ended follow-up of PR #9 on `base`'s fields, created at `at`, that recorded `waits` until `until`. */
function waited(
  base: ReadRecord["record"],
  at: string,
  until: string,
  fields: Partial<ReadRecord["record"]> = {},
): ReadRecord {
  return {
    record: {
      ...base,
      id: `${at.replace(/[-:.]/g, "")}-cccccccc`,
      createdAt: at,
      ...fields,
    },
    state: {
      kind: "ended",
      exit: { at, code: 0, signal: null },
      process: null,
    },
    result: "waits",
    waitsUntil: until,
  };
}

it("counts a wait a person's answer started as the first of a new count", () => {
  const w = world();
  current = w;
  const base = earlierRecord(w, {
    id: OLD,
    account: "a",
    action: "followup",
    pr: 9,
    repo: SLUG,
  });
  const until = "2026-11-01T00:00:00.000Z";
  const three = [1, 2, 3].map((h) =>
    waited(base, `2026-10-31T1${h}:00:00.000Z`, until),
  );
  expect(waitStreak(three, SLUG, 9)?.count).toBe(3);
  const answered = waited(base, "2026-10-31T15:00:00.000Z", until, {
    answered: {
      question: "Run the follow-up again?",
      option: "Run it again",
      recommended: true,
      changes: "a later tick starts the follow-up again once",
      costs: "one more pass",
      by: "a-person",
      url: "https://example.com/answer",
    },
  });
  expect(waitStreak([...three, answered], SLUG, 9)).toMatchObject({
    record: answered.record.id,
    count: 1,
  });
});

it("reads a question as a wait only when it names a rate limit and carries no routine tag", () => {
  const w = world();
  current = w;
  const base = earlierRecord(w, {
    id: OLD,
    account: "a",
    action: "followup",
    pr: 9,
    repo: SLUG,
  });
  const asked = (said: string): ReadRecord => ({
    record: base,
    state: {
      kind: "ended",
      exit: { at: "2026-10-31T13:05:00.000Z", code: 1, signal: null, said },
      process: null,
    },
    result: "failed",
  });
  expect(waitUntil(asked(RATE_LIMITED))).toBe("2026-10-31T14:05:00.000Z");
  expect(
    waitUntil(asked("Question: which version does this ship in?")),
  ).toBeNull();
  expect(
    waitUntil(
      asked("Question: [person-owed] who lifts the tracker's rate limit?"),
    ),
  ).toBeNull();
  expect(waitUntil({ ...asked(RATE_LIMITED), result: "parked" })).toBeNull();
});

it("counts, at a pass's exit, an earlier wait whose wrapper died before writing its exit", () => {
  const w = world();
  current = w;
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const ids = [1, 2, 3].map((n) => {
    const id = `20261031T1${n}0000Z-dddddddd`;
    earlierRecord(w, {
      id,
      account: "a",
      action: "followup",
      pr: 9,
      repo: SLUG,
      createdAt: `2026-10-31T1${n}:00:00.000Z`,
    });
    expect(
      resultMain(
        [id, "earlier-token", "waits", "--until", until],
        dispatchState(w),
      ),
    ).toBe(0);
    // The first wrapper died after its pass recorded the wait: no exit.
    if (n > 1)
      recordExit(
        id,
        { at: `2026-10-31T1${n}:05:00.000Z`, code: 0, signal: null },
        dispatchState(w),
      );
    return id;
  });
  const third = readEnded(String(ids[2]), dispatchState(w));
  expect(third).not.toBeNull();
  if (third === null) return;
  // The third wait in a row is a person's: its marker is answered, not released.
  expect(waitEnd(third, dispatchState(w))).toBe(false);
});

it("takes a waits result on a follow-up's record", () => {
  const w = world();
  current = w;
  const id = "20261110T110200Z-aaaaaaaa";
  earlierRecord(w, { id, account: "a", action: "followup", pr: 9 });
  const until = new Date(Date.now() + 10 * 60_000).toISOString();
  expect(
    resultMain(
      [id, "earlier-token", "waits", "--until", until],
      dispatchState(w),
    ),
  ).toBe(0);
  expect(
    stateDb(dispatchState(w))
      .query("SELECT result, result_until FROM launches WHERE id = ?")
      .get(id),
  ).toEqual({ result: "failed", result_until: until });
});

it("tells a follow-up's pass that a rate limit is a wait, not a question", () => {
  const w = world();
  current = w;
  const record = earlierRecord(w, {
    id: "20261110T110300Z-bbbbbbbb",
    account: "a",
    action: "followup",
    pr: 9,
    command: "/followup",
    marker: 901,
  });
  const prompt = followupPassArgv(record, []).at(-1) ?? "";
  expect(prompt).toContain(
    `dispatch result ${record.id} earlier-token waits --until <that time>`,
  );
  expect(prompt).toContain("API rate limit exceeded");
  expect(prompt).toContain("ask no question");
});
