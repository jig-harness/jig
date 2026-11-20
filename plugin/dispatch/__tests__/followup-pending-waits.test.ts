/**
 * A follow-up whose pass found an arm still pending records
 * `waits --reason pending`: the tick holds it until the time it named and
 * starts it again, never as a rate limit, and hands it to a person once
 * `dispatch.followup_within` has passed since the first pass that found the
 * arm pending, the window starting again on a newer arm. Before it goes to
 * a person, the tick reads the release tags and the deploy runs the arm
 * names again, and runs the follow-up once more when every tag exists and
 * every run has finished. A follow-up stage with no
 * `dispatch.followup_command` runs
 * the plugin's own follow-up skill, and a repository whose follow-up stage
 * is off reads no merged pull request for a default it does not use.
 */
import { afterEach, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REREAD_MS, rereadPendingArms } from "../lib/arm-reread.ts";
import { armTags, waitStreak, waitWords } from "../lib/followup-waits.ts";
import { type ReadRecord, readRecord } from "../lib/launches.ts";
import { DEFAULT_FOLLOWUP_COMMAND } from "../lib/section.ts";
import { followupPassArgv } from "../lib/session.ts";
import { stateDb } from "../lib/state.ts";
import { armRuns, type WaitFor } from "../lib/wait-for.ts";
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
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
import { failed, ok } from "../../shared/outcome.ts";

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

const TAG = "v9.9.9";
const TAG_ARM = `release: tag ${TAG} waits for the release workflow`;

/** Two passes that found `arm` pending, the first two hours back: the second is past followup_within. */
async function pastWindow(w: World, arm = TAG_ARM): Promise<string> {
  const past = () => isoFromMs(currentMs() - 1000);
  const args = (until: string) => [
    "--until",
    until,
    "--reason",
    "pending",
    "--arm",
    arm,
  ];
  const first = await passWaits(w, args(past()));
  await releasedWith(
    w,
    `launch record ${first}'s pass found the arm ${arm} still pending`,
  );
  launchedEarlier(w, first, 2 * 3_600_000);
  return passWaits(w, args(past()));
}

it("runs a follow-up past followup_within again, raising no need, once the release tag its arm names exists", async () => {
  const w = fixture();
  const second = await pastWindow(w);
  writeFileSync(join(w.dir, "release-tags.json"), JSON.stringify([TAG]));

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  expect(notices(after)).toEqual([]);
  expect(after.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(
        `launch record ${second}'s pass found the arm ${TAG_ARM} still pending past dispatch.followup_within, and read again this tick, ${TAG} now exist`,
      ),
    }),
  );
  expect(markers(w)).toEqual([]);

  const runs = claudeRuns(w).length;
  const [again] = launches(await applyTick(w, false));
  expect(again).toMatchObject({ action: "followup", outcome: "launched" });
  await waitFor("the run after the re-read", () => claudeRuns(w).length > runs);
}, 480_000);

const RUN_LINK = `https://github.com/${SLUG}/actions/runs/4242`;
const RUN_ARM = `website: the deploy run ${RUN_LINK} contains the merge and is pending`;

it("runs a follow-up past followup_within again, raising no need, once the deploy run its arm links to has finished", async () => {
  const w = fixture();
  const second = await pastWindow(w, RUN_ARM);
  writeFileSync(
    join(w.dir, "run-status.json"),
    JSON.stringify({ [`${SLUG}/4242`]: "completed success" }),
  );

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  expect(notices(after)).toEqual([]);
  expect(after.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(
        `launch record ${second}'s pass found the arm ${RUN_ARM} still pending past dispatch.followup_within, and read again this tick, the run ${SLUG}#4242 finished`,
      ),
    }),
  );
  expect(markers(w)).toEqual([]);
}, 480_000);

it("raises the follow-up for a person when the deploy run its arm links to is still pending, or was cancelled, at the re-read", async () => {
  const w = fixture();
  const second = await pastWindow(w, RUN_ARM);
  // A cancelled run was superseded, not settled; a pending one has not settled yet.
  writeFileSync(
    join(w.dir, "run-status.json"),
    JSON.stringify({ [`${SLUG}/4242`]: "completed cancelled" }),
  );

  const after = await applyTick(w, false);
  const raised = notices(after).filter((n) => n.target === "PR #9");
  expect(raised).toHaveLength(1);
  expect(raised[0]?.reason).toContain(
    `its pass under launch record ${second} found the arm ${RUN_ARM} still pending`,
  );
}, 480_000);

it("raises one failed follow-up naming the arm when its release tag is still missing at the re-read", async () => {
  const w = fixture();
  const second = await pastWindow(w);

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  const raised = notices(after).filter((n) => n.target === "PR #9");
  expect(raised).toHaveLength(1);
  expect(raised[0]).toMatchObject({ cause: "followup-failed" });
  expect(raised[0]?.reason).toContain(
    `its pass under launch record ${second} found the arm ${TAG_ARM} still pending`,
  );
}, 480_000);

const BOTH_TAGS: WaitFor = { reason: "pending", arm: "v1.0.0 v1.0.1" };
const ONE_TAG: WaitFor = { reason: "pending", arm: "v1.0.1" };

/** A time on 2026-10-31 at hour `h`, minute `m`, UTC. */
const atTime = (h: number, m: number) =>
  `2026-10-31T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

/** The earlier follow-up record of PR #9 that every wait of a streak is built on. */
function streakBase(): ReadRecord["record"] {
  const w = world();
  current = w;
  return earlierRecord(w, {
    id: "20261031T100000Z-aaaaaaaa",
    account: "a",
    action: "followup",
    pr: 9,
    repo: SLUG,
  });
}

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

it("keeps the window when a later arm only drops release tags", () => {
  const base = streakBase();
  const both = BOTH_TAGS;
  const rest = ONE_TAG;
  const streak = waitStreak(
    [
      waited(base, "2026-10-31T06:55:00.000Z", both),
      waited(base, "2026-10-31T08:01:00.000Z", rest),
    ],
    SLUG,
    9,
  );
  expect(streak).toMatchObject({
    spent: true,
    pendingSince: "2026-10-31T06:55:00.000Z",
  });
});

it("reads a shrunken arm once, and never reads it again in a later run", () => {
  const base = streakBase();
  const both = BOTH_TAGS;
  const rest = ONE_TAG;
  const at = atTime;
  const first = [waited(base, at(6, 0), both), waited(base, at(7, 10), rest)];
  expect(waitStreak(first, SLUG, 9)).toMatchObject({
    spent: true,
    reread: ["v1.0.1"],
  });
  // The retry's window, then a pass past it on the arm already read: a person's.
  const later = [
    ...first,
    waited(base, at(7, 20), rest),
    waited(base, at(8, 30), rest),
  ];
  expect(waitStreak(later, SLUG, 9)).toMatchObject({
    spent: true,
    reread: [],
  });
});

it("never reads an arm a run went past its window on, though that run's re-read was suppressed", () => {
  const base = streakBase();
  const both = BOTH_TAGS;
  const rest = ONE_TAG;
  const at = atTime;
  // The first run reads the combined arm; the second goes past its window on the shrunken arm with no re-read allowed.
  const runs = [
    waited(base, at(6, 0), both),
    waited(base, at(7, 10), both),
    waited(base, at(7, 20), both),
    waited(base, at(8, 30), rest),
  ];
  expect(waitStreak(runs, SLUG, 9)).toMatchObject({ spent: true, reread: [] });
  // A person restarts it: the same arm, past its window again, is not read.
  const restarted = [
    ...runs,
    waited(base, at(8, 40), rest),
    waited(base, at(9, 50), rest),
  ];
  expect(waitStreak(restarted, SLUG, 9)).toMatchObject({
    spent: true,
    reread: [],
  });
});

it("starts a pending window again on a newer arm, re-reads an arm past its window once, and bounds the run", () => {
  const base = streakBase();
  const on = (tag: string): WaitFor => ({
    reason: "pending",
    arm: `release: tag ${tag} waits for the release run`,
  });
  const at = atTime;
  // A newer release replaced the one the first pass waited for: a fresh window.
  const newer = [
    waited(base, at(6, 55), on("v1.0.0")),
    waited(base, at(8, 1), on("v1.0.1")),
  ];
  expect(waitStreak(newer, SLUG, 9)).toMatchObject({
    spent: false,
    pendingSince: at(8, 1),
  });
  // The same arm past the window: spent, and its tag read again once.
  const same = [
    waited(base, at(6, 55), on("v1.0.0")),
    waited(base, at(8, 1), on("v1.0.0")),
  ];
  expect(waitStreak(same, SLUG, 9)).toMatchObject({
    spent: true,
    reread: ["v1.0.0"],
  });
  // The run after it, whether the re-read or a person started it, has a window of its own.
  const again = [...same, waited(base, at(8, 20), on("v1.0.0"))];
  expect(waitStreak(again, SLUG, 9)).toMatchObject({
    spent: false,
    pendingSince: at(8, 20),
  });
  // Past that window on the same arm it is a person's, its tag read no more.
  const still = [...again, waited(base, at(9, 30), on("v1.0.0"))];
  expect(waitStreak(still, SLUG, 9)).toMatchObject({
    spent: true,
    reread: [],
  });
  // An arm whose words change but name no tag never starts its window again.
  const reworded = [
    waited(base, at(6, 55), { reason: "pending", arm: "deploy: rolling out" }),
    waited(base, at(8, 1), { reason: "pending", arm: "deploy: still going" }),
  ];
  expect(waitStreak(reworded, SLUG, 9)).toMatchObject({ spent: true });
  // A window that began untagged takes the first tag a later pass names, so a newer tag after it starts a window again.
  const adopted = [
    waited(base, at(6, 55), { reason: "pending", arm: "deploy" }),
    waited(base, at(7, 10), on("v1.0.0")),
    waited(base, at(8, 1), on("v1.0.1")),
  ];
  expect(waitStreak(adopted, SLUG, 9)).toMatchObject({
    spent: false,
    pendingSince: at(8, 1),
  });
  // An arm naming no tag past its window is spent with nothing to read.
  const untagged = [
    waited(base, at(6, 55), { reason: "pending", arm: "deploy" }),
    waited(base, at(8, 1), { reason: "pending", arm: "deploy" }),
  ];
  expect(waitStreak(untagged, SLUG, 9)).toMatchObject({
    spent: true,
    reread: [],
  });
  // However often a newer arm starts the window again, three windows after the first wait the run is a person's.
  const stream = [6, 7, 8, 9].map((h, i) =>
    waited(base, at(h, 0), on(`v1.0.${i}`)),
  );
  expect(waitStreak(stream.slice(0, 3), SLUG, 9)).toMatchObject({
    spent: false,
  });
  expect(waitStreak(stream, SLUG, 9)).toMatchObject({
    spent: true,
    reread: [],
  });
});

it("starts a pending window again on a newer deploy run, and re-reads the run an arm past its window links to", () => {
  const base = streakBase();
  const on = (id: number): WaitFor => ({
    reason: "pending",
    arm: `website: deploy https://github.com/${SLUG}/actions/runs/${id} is pending`,
  });
  const at = atTime;
  // A newer run that contains the merge replaced the one the first pass waited for: a fresh window.
  const newer = [
    waited(base, at(6, 55), on(100)),
    waited(base, at(8, 1), on(101)),
  ];
  expect(waitStreak(newer, SLUG, 9)).toMatchObject({
    spent: false,
    pendingSince: at(8, 1),
  });
  // The same run past the window: spent, and the run read again once.
  const same = [
    waited(base, at(6, 55), on(100)),
    waited(base, at(8, 1), on(100)),
  ];
  expect(waitStreak(same, SLUG, 9)).toMatchObject({
    spent: true,
    reread: [],
    rereadRuns: [{ slug: SLUG, id: 100 }],
  });
  // Past the next window on the same run it is a person's, read no more.
  const still = [
    ...same,
    waited(base, at(8, 20), on(100)),
    waited(base, at(9, 30), on(100)),
  ];
  expect(waitStreak(still, SLUG, 9)).toMatchObject({
    spent: true,
    rereadRuns: [],
  });
});

it("reads the workflow runs an arm links to", () => {
  expect(
    armRuns(
      "deploy https://github.com/o/r/actions/runs/123 and https://github.com/o/r/actions/runs/123/job/9, then https://github.com/x/y.z/actions/runs/77.",
    ),
  ).toEqual([
    { slug: "o/r", id: 123 },
    { slug: "x/y.z", id: 77 },
  ]);
  expect(armRuns("https://github.com/../r/actions/runs/5")).toEqual([]);
  expect(armRuns("deploy run 123 is pending (PR #12)")).toEqual([]);
  expect(armRuns(undefined)).toEqual([]);
});

it("re-reads the runs of a spent pending arm, settling it only once every run it links to has finished", async () => {
  const w = world();
  current = w;
  const b = earlierRecord(w, {
    id: "20261031T100009Z-aaaaaaaa",
    account: "a",
    action: "followup",
    pr: 9,
    repo: SLUG,
  });
  const arm: WaitFor = {
    reason: "pending",
    arm: `deploy https://github.com/${SLUG}/actions/runs/7 and tag v3.0.0`,
  };
  const records = [
    waited(b, "2026-10-31T06:55:00.000Z", arm),
    waited(b, "2026-10-31T08:01:00.000Z", arm),
  ];
  const repo = { path: w.dir, slug: SLUG, defaultBranch: "main" };
  const nowMs = parseMs("2026-10-31T08:05:00.000Z");
  const asked: unknown[] = [];
  const settle = (finished: string[], tags: string[]) =>
    rereadPendingArms(
      repo,
      [{ number: 9 }],
      records,
      nowMs,
      undefined,
      async () => ok(new Set(tags)),
      async (_repo, runs) => {
        asked.push(runs);
        return ok(new Set(finished));
      },
    );
  const id = records[1]?.record.id ?? "";
  expect(await settle([`run:${SLUG}/7`], ["v3.0.0"])).toEqual(
    ok(new Set([id])),
  );
  expect(asked).toEqual([[{ slug: SLUG, id: 7 }]]);
  expect(await settle([], ["v3.0.0"])).toEqual(ok(new Set()));
  expect(await settle([`run:${SLUG}/7`], [])).toEqual(ok(new Set()));
  const refused = await rereadPendingArms(
    repo,
    [{ number: 9 }],
    records,
    nowMs,
    undefined,
    async () => ok(new Set(["v3.0.0"])),
    async () => failed("refused", "the forge did not answer"),
  );
  expect(refused.ok).toBe(false);
});

it("reads the release tags an arm names", () => {
  expect(armTags("release: tag v0.286.0 waits for its run")).toEqual([
    "v0.286.0",
  ]);
  expect(armTags("release: v1.2.3, v1.2.4; deploy pending.")).toEqual([
    "v1.2.3",
    "v1.2.4",
  ]);
  expect(armTags("deploy: the run is still going (PR #12)")).toEqual([]);
  expect(armTags(undefined)).toEqual([]);
});

it("re-reads the tags of each spent pending arm in one read, settling only those whose every tag exists", async () => {
  const w = world();
  current = w;
  const base = (pr: number) =>
    earlierRecord(w, {
      id: `20261031T10000${pr}Z-aaaaaaaa`,
      account: "a",
      action: "followup",
      pr,
      repo: SLUG,
    });
  const arm = (tags: string): WaitFor => ({
    reason: "pending",
    arm: `release: ${tags} waits for the release run`,
  });
  const late = (pr: number, tags: string) => {
    const b = base(pr);
    return [
      waited(b, "2026-10-31T06:55:00.000Z", arm(tags)),
      { ...waited(b, "2026-10-31T08:01:00.000Z", arm(tags)) },
    ].map((r) => ({
      ...r,
      record: { ...r.record, id: `${r.record.id}-${pr}` },
    }));
  };
  const records = [...late(9, "v2.0.0"), ...late(10, "v2.0.0 v2.0.1")];
  const asked: string[][] = [];
  const repo = { path: w.dir, slug: SLUG, defaultBranch: "main" };
  const nowMs = parseMs("2026-10-31T08:05:00.000Z");
  const settled = await rereadPendingArms(
    repo,
    [{ number: 9 }, { number: 10 }],
    records,
    nowMs,
    undefined,
    async (_repo, tags) => {
      asked.push([...tags]);
      return ok(new Set(["v2.0.0"]));
    },
  );
  expect(asked).toEqual([["v2.0.0", "v2.0.1"]]);
  expect(settled).toEqual(ok(new Set([records[1]?.record.id ?? ""])));
  const noRead = () => {
    throw new Error("no read is owed");
  };
  const none = await rereadPendingArms(
    repo,
    [],
    records,
    nowMs,
    undefined,
    noRead,
  );
  expect(none).toEqual(ok(new Set()));
  // A spent pass that ended longer ago than a few ticks is not read again.
  const later = await rereadPendingArms(
    repo,
    [{ number: 9 }],
    records,
    nowMs + REREAD_MS,
    undefined,
    noRead,
  );
  expect(later).toEqual(ok(new Set()));
  const refused = await rereadPendingArms(
    repo,
    [{ number: 9 }],
    records,
    nowMs,
    undefined,
    async () => failed("refused", "the forge did not answer"),
  );
  expect(refused.ok).toBe(false);
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
  expect(prompt).toContain(
    "the link of the deploy run it waits for (https://github.com/<owner>/<repo>/actions/runs/<id>)",
  );
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
