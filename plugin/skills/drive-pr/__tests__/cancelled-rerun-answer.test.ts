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
import { answerGrantsRerun } from "../scripts/lib/cancelled-recovery.ts";
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

/**
 * One recovery on the forge's state, `offset` milliseconds after the real
 * clock: one cancelled run of workflow 10, every check passing, each re-run
 * recorded.
 */
const PROBE = `
import { observeCancellation, claimCancellation, readCancellation } from ${JSON.stringify(join(LIB, "cancelled-recovery-state.ts"))};
import { recoverCancelled } from ${JSON.stringify(join(LIB, "cancelled-recovery.ts"))};
import { currentMs } from ${JSON.stringify(join(SCRIPTS, "..", "..", "..", "shared", "time.ts"))};
const head = ${JSON.stringify(HEAD)};
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
  confirm: async () => true,
  rerunnable: async (_pr, runs) => runs.map((r) => r.id),
  rerun: async (id) => { calls.push(id); return { code: 0, stderr: "" }; },
  park: async (_pr, reason) => { parks.push(reason); },
});
console.log(JSON.stringify({ answer, calls, parks, record: await readCancellation("12", head) }));
`;

async function recover(forge: Forge, offset: number) {
  const probe = join(forge.dir, "probe.ts");
  writeFileSync(probe, PROBE);
  const r = await runIn(forge, probe, [String(offset)], { env: DRIVER });
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as {
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
  const spent = await recover(forge, 120_000);
  expect(spent.answer).toBe("parked");
  expect(spent.calls).toEqual([]);
  const reason = spent.parks[0] ?? "";
  expect(reason).toContain("once-per-head re-run was already requested");
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
  const rearmed = await runIn(
    forge,
    "-e",
    [
      `import(${JSON.stringify(join(LIB, "driver", "rearm.ts"))}).then(async (m) => console.log(JSON.stringify(await m.admitAnsweredParks(await m.readDriveState("12"), false))))`,
    ],
    { env: DRIVER },
  );
  expectSpawnExit(rearmed, 0);
  return { forge, rearmed };
}

describe("answering the cancelled-ci park", () => {
  test("Re-run safely grants one more re-run instead of the same park again", async () => {
    const { forge, rearmed } = await parkedAndAnswered(
      "answer cancelled-ci: choose Re-run safely",
    );
    expect(rearmed.stderr).toContain("granted one more cancelled-run re-run");
    const granted = await recover(forge, 120_000);
    expect(granted).toMatchObject({ answer: "wait", calls: [1] });
    expect(granted.record?.grants).toBe(1);
    // Still unreplaced after the granted re-run: the park says what changed.
    const again = await recover(forge, 240_000);
    expect(again.answer).toBe("parked");
    expect(again.calls).toEqual([]);
    expect(again.parks[0]).toContain(
      "the re-run a person's answer granted was requested",
    );
    expect(again.parks[0]).toContain("after 1 further re-run(s)");
  });

  test("approving the recommended option grants the re-run too", async () => {
    const { forge } = await parkedAndAnswered("answer cancelled-ci: approve");
    expect(await recover(forge, 120_000)).toMatchObject({
      answer: "wait",
      calls: [1],
    });
  });

  test("Repair workflow first grants no re-run", async () => {
    const { forge, rearmed } = await parkedAndAnswered(
      "answer cancelled-ci: choose Repair workflow first",
    );
    expect(rearmed.stderr).not.toContain("granted one more");
    const after = await recover(forge, 120_000);
    expect(after.answer).toBe("parked");
    expect(after.calls).toEqual([]);
  });
});

describe("answerGrantsRerun", () => {
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
