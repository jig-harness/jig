/**
 * A person's answer to the `cancelled-ci` park, end to end against the fake
 * forge in `provisional-fixtures.ts`: the once-per-head re-run is spent, the
 * drive parks, a person answers, the drive re-arms, and the next recovery
 * either requests the re-run the answer granted or parks naming what changed.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  answerGrantsRerun,
  answeredHead,
  REPLACEMENT_WINDOW_MS,
} from "../scripts/lib/cancelled-recovery.ts";
import { cancelledCiDecision } from "../scripts/lib/cancelled-recovery-live.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import type { PendingVerdict } from "../scripts/lib/state/pass-handoff.ts";
import {
  fakeForge,
  type Forge,
  runIn,
  SCRIPTS,
} from "./provisional-fixtures.ts";
import { writeState } from "./state-rows.ts";
import { currentMs, isoFromMs } from "../../../shared/time.ts";

const HEAD = "a".repeat(40);
const DRIVER = { DRIVE_PR_TARGET: "12" };
const LIB = join(SCRIPTS, "lib");
/** A minute past the replacement window. */
const AFTER = REPLACEMENT_WINDOW_MS + 60_000;

/**
 * One recovery on the forge's state, `offset` milliseconds after the real
 * clock: one cancelled run of workflow 10, each re-run recorded. Mode `held`
 * refuses the run as created under the CI hold; `age` instead moves the
 * recorded times past the replacement window, as a later arm finds them, and `ungrant`
 * puts back the spent claim a grant released, as an arm that stopped before
 * its grant leaves it.
 */
const PROBE = `
import { observeCancellation, claimCancellation, extendCancellation, readCancellation, grantCancellation, releasePendingGrant } from ${JSON.stringify(join(LIB, "cancelled-recovery-state.ts"))};
import { recoverCancelled } from ${JSON.stringify(join(LIB, "cancelled-recovery.ts"))};
import { driveDb } from ${JSON.stringify(join(LIB, "state", "db.ts"))};
import { resolveStateDir } from ${JSON.stringify(join(LIB, "state", "store.ts"))};
import { currentMs } from ${JSON.stringify(join(SCRIPTS, "..", "..", "..", "shared", "time.ts"))};
const head = ${JSON.stringify(HEAD)};
const mode = process.argv[3] ?? "";
if (mode.startsWith("grant:")) {
  console.log(await grantCancellation("12", mode.slice(6), "answer-1"));
  process.exit(0);
}
if (mode === "extend") {
  const earlier = (await readCancellation("12", head))?.requestedRuns ?? [];
  const more = [...earlier, { id: 5, workflowId: 12, attempt: 1, at: currentMs() }];
  const first = await extendCancellation("12", head, earlier, more);
  const second = await extendCancellation("12", head, earlier, [...more, { id: 6, workflowId: 13, attempt: 1, at: 0 }]);
  console.log(JSON.stringify({ first, second, record: await readCancellation("12", head) }));
  process.exit(0);
}
if (mode === "age" || mode === "ungrant") {
  const { db } = driveDb(await resolveStateDir());
  db.run(mode === "age"
    ? "UPDATE cancelled_ci SET first_seen = first_seen - ${AFTER}, requested_at = requested_at - ${AFTER}"
    : "UPDATE cancelled_ci SET requested_at = first_seen, grants = 0, granted_for = NULL");
  process.exit(0);
}
const clock = currentMs() + Number(process.argv[2]);
const calls = [];
const parks = [];
const run = { id: 1, workflowId: 10, checkSuiteId: 1, status: "completed", conclusion: "cancelled",
  createdAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", attempt: 1 };
const job = { name: "gate", status: "completed", conclusion: "cancelled", suiteId: 1 };
const answer = await recoverCancelled("12", head, [job], [run], {
  now: () => clock,
  observe: observeCancellation,
  claim: claimCancellation,
  extend: extendCancellation,
  confirm: async () => true,
  rerunnable: async (_pr, runs) => (mode === "held" ? [] : runs.map((r) => r.id)),
  rerun: async (id) => { calls.push(id); return { code: 0, stderr: "" }; },
  park: async (_pr, reason) => { parks.push(reason); },
  releaseGrant: releasePendingGrant,
});
console.log(JSON.stringify({ answer, calls, parks, record: await readCancellation("12", head) }));
`;

async function probe(forge: Forge, offset: number, mode = "") {
  const file = join(forge.dir, "probe.ts");
  writeFileSync(file, PROBE);
  const r = await runIn(forge, file, [String(offset), mode], { env: DRIVER });
  expectSpawnExit(r, 0);
  return r.stdout;
}

/** Move the recorded observation and claim past the replacement window. */
const age = (forge: Forge) => probe(forge, 0, "age");

async function recover(forge: Forge, offset: number, mode = "") {
  return JSON.parse(await probe(forge, offset, mode)) as {
    answer: string;
    calls: number[];
    parks: string[];
    record: { requestedAt: number | null; grants: number } | null;
  };
}

/** Spend the head's re-run, park as the drive does, and post `answer`. */
async function parkedAndAnswered(answer: string) {
  const forge = fakeForge();
  // Past the grace period: the automatic re-run is requested.
  const first = await recover(forge, 31_000);
  expect(first).toMatchObject({ answer: "wait", calls: [1] });
  // Past the replacement window: the spent budget parks.
  const spent = await recover(forge, AFTER);
  expect(spent.answer).toBe("parked");
  expect(spent.calls).toEqual([]);
  const reason = spent.parks[0] ?? "";
  expect(reason).toContain("the once-per-head re-run was requested");
  expect(reason).toContain("run 1 got no new attempt");
  // The person answers well after the claim's replacement window.
  await age(forge);
  const decision = cancelledCiDecision(reason);
  const parkedAt = currentMs() - 60_000;
  writeState(forge.stateDir, "12", {
    ...freshState(12),
    parked: [
      {
        key: "cancelled-ci",
        kind: "finding",
        reason: decision.call.question,
        class: "human-decision",
        decision,
        round: 0,
        at: isoFromMs(parkedAt),
      },
    ],
  });
  const at = isoFromMs(parkedAt + 30_000);
  forge.write("comments-12.json", [
    {
      id: 1,
      user: { login: "lead" },
      author_association: "OWNER",
      created_at: at,
      updated_at: at,
      html_url: "https://example.invalid/answer",
      body: answer,
    },
  ]);
  return { forge, rearmed: await rearm(forge) };
}

async function rearm(forge: Forge) {
  const rearmed = await runIn(
    forge,
    "-e",
    [
      `import(${JSON.stringify(join(LIB, "driver", "rearm.ts"))}).then(async (m) => console.log(JSON.stringify(await m.admitAnsweredParks(await m.readDriveState("12"), false))))`,
    ],
    { env: DRIVER },
  );
  expectSpawnExit(rearmed, 0);
  return rearmed;
}

describe("answering the cancelled-ci park", () => {
  test("Re-run safely grants one more re-run instead of the same park again", async () => {
    const { forge, rearmed } = await parkedAndAnswered(
      "answer cancelled-ci: choose Re-run safely",
    );
    expect(rearmed.stderr).toContain("granted one more cancelled-run re-run");
    const granted = await recover(forge, AFTER);
    expect(granted).toMatchObject({ answer: "wait", calls: [1] });
    expect(granted.record?.grants).toBe(1);
    // Still unreplaced after the granted re-run: the park says what changed.
    const again = await recover(forge, 2 * AFTER);
    expect(again.answer).toBe("parked");
    expect(again.calls).toEqual([]);
    expect(again.parks[0]).toContain(
      "the re-run a person's answer granted was requested",
    );
    expect(again.parks[0]).toContain("granted 1 more re-run(s) on this head");
  });

  test("an answer counts once, and an arm that stopped before its grant loses nothing", async () => {
    const { forge } = await parkedAndAnswered(
      "answer cancelled-ci: choose Re-run safely",
    );
    expect(await recover(forge, AFTER)).toMatchObject({ calls: [1] });
    await age(forge);
    // The next arm reads the same answers, kept until a pass completes.
    const again = await rearm(forge);
    expect(again.stderr).not.toContain("granted one more");
    expect((await recover(forge, 0)).record).toMatchObject({ grants: 1 });
    expect((await recover(forge, 0)).record?.requestedAt).toBeNumber();
    // As if the unparking arm had stopped before it granted.
    await probe(forge, 0, "ungrant");
    expect((await rearm(forge)).stderr).toContain("granted one more");
    expect(await recover(forge, AFTER)).toMatchObject({
      answer: "wait",
      calls: [1],
    });
  });

  test("a granted re-run the CI hold still refuses stops naming the manual step", async () => {
    const { forge } = await parkedAndAnswered(
      "answer cancelled-ci: choose Re-run safely",
    );
    const held = await recover(forge, AFTER, "held");
    expect(held.answer).toBe("parked");
    expect(held.calls).toEqual([]);
    expect(held.parks[0]).toContain("created under the CI hold");
    expect(held.parks[0]).toContain("granted 1 more re-run(s) on this head");
    expect(held.parks[0]).toContain("gh run rerun 1");
  });

  test("approving the recommended option grants the re-run too", async () => {
    const { forge } = await parkedAndAnswered("answer cancelled-ci: approve");
    expect(await recover(forge, AFTER)).toMatchObject({
      answer: "wait",
      calls: [1],
    });
  });

  test("Repair workflow first grants no re-run", async () => {
    const { forge, rearmed } = await parkedAndAnswered(
      "answer cancelled-ci: choose Repair workflow first",
    );
    expect(rearmed.stderr).not.toContain("granted one more");
    const after = await recover(forge, AFTER);
    expect(after.answer).toBe("parked");
    expect(after.calls).toEqual([]);
  });
});

describe("a grant is bound to its head and waits for a young claim", () => {
  test("an answer for another head grants nothing", async () => {
    const forge = fakeForge();
    expect(await recover(forge, 31_000)).toMatchObject({ calls: [1] });
    await age(forge);
    expect((await probe(forge, 0, `grant:${"b".repeat(40)}`)).trim()).toBe("0");
    expect((await recover(forge, 0)).record?.grants).toBe(0);
  });

  test("a claim younger than the window keeps the grant pending until it ages out", async () => {
    const forge = fakeForge();
    expect(await recover(forge, 31_000)).toMatchObject({ calls: [1] });
    expect((await probe(forge, 0, `grant:${HEAD}`)).trim()).toBe("1");
    // Still inside the replacement window: the claim stands, the grant waits.
    expect(await recover(forge, 40_000)).toMatchObject({
      answer: "wait",
      calls: [],
    });
    // The window passed with no replacement: the grant releases the claim.
    const after = await recover(forge, AFTER);
    expect(after).toMatchObject({ answer: "wait", calls: [1] });
    expect(after.record?.grants).toBe(1);
  });
});

describe("the runs a claim re-ran", () => {
  test("are kept with the claim, and a workflow it did not cover extends it once", async () => {
    const forge = fakeForge();
    expect(await recover(forge, 31_000)).toMatchObject({ calls: [1] });
    const extended = JSON.parse(await probe(forge, 0, "extend")) as {
      first: boolean;
      second: boolean;
      record: {
        workflowIds: number[];
        requestedRuns: { id: number; attempt: number }[];
      };
    };
    expect(extended.first).toBe(true);
    expect(extended.second).toBe(false);
    expect(extended.record.workflowIds).toEqual([10, 12]);
    expect(extended.record.requestedRuns.map((run) => run.id)).toEqual([1, 5]);
    expect(extended.record.requestedRuns[0]?.attempt).toBe(1);
  });
});

describe("answerGrantsRerun", () => {
  test("a note conditioning the answer grants nothing", () => {
    const d = cancelledCiDecision("Cancelled CI on head x: run 1.");
    const base = {
      author: "lead",
      at: "2026-11-16T10:00:00Z",
      url: "https://example.invalid/a",
      body: "x",
      choice: {
        option: "Re-run safely",
        recommended: true,
        form: "choose" as const,
        note: "only after the concurrency config is repaired",
      },
    };
    const v: PendingVerdict = {
      kind: "finding",
      key: "cancelled-ci",
      reason: d.call.question,
      answers: [base],
      decision: d,
    };
    expect(answerGrantsRerun(v)).toBe(false);
    expect(
      answerGrantsRerun({
        ...v,
        answers: [{ ...base, choice: { ...base.choice, note: "" } }],
      }),
    ).toBe(true);
  });

  test("the head comes from the park's framing", () => {
    const d = cancelledCiDecision(`Cancelled CI on head ${HEAD}: run 1: x.`);
    expect(
      answeredHead({
        kind: "finding",
        key: "cancelled-ci",
        reason: "",
        answers: [],
        decision: d,
      }),
    ).toBe(HEAD);
    expect(
      answeredHead({
        kind: "finding",
        key: "cancelled-ci",
        reason: "",
        answers: [],
      }),
    ).toBeNull();
  });

  const decision = cancelledCiDecision("Cancelled CI on head x: run 1.");
  const answer = (option: string) => ({
    author: "lead",
    at: "2026-11-16T10:00:00Z",
    url: "https://example.invalid/a",
    body: `answer cancelled-ci: choose ${option}`,
    choice: {
      option,
      recommended: option === "Re-run safely",
      form: "choose" as const,
    },
  });
  const verdict = (over: Partial<PendingVerdict>): PendingVerdict => ({
    kind: "finding",
    key: "cancelled-ci",
    reason: decision.call.question,
    answers: [answer("Re-run safely")],
    decision,
    ...over,
  });
  test("only every answer choosing the re-run, on the cancelled-ci park, grants", () => {
    expect(answerGrantsRerun(verdict({}))).toBe(true);
    expect(
      answerGrantsRerun(
        verdict({
          answers: [answer("Re-run safely"), answer("Repair workflow first")],
        }),
      ),
    ).toBe(false);
    expect(answerGrantsRerun(verdict({ answers: [] }))).toBe(false);
    expect(answerGrantsRerun(verdict({ provisional: true }))).toBe(false);
    expect(answerGrantsRerun(verdict({ key: "other" }))).toBe(false);
    const { decision: _decision, ...unframed } = verdict({});
    expect(answerGrantsRerun(unframed)).toBe(false);
  });
});
