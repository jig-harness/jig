/**
 * A stopped drive the tick would launch, held only by a launch nobody can
 * show running: the plan keeps it as held, and past the bound it raises a
 * need naming the hold.
 */
import { describe, expect, it } from "bun:test";
import { ok } from "../../shared/outcome.ts";
import type { ReadClaim } from "../../shared/records/shared.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import { classOf } from "../lib/actions/notify.ts";
import type { NeedCause } from "../lib/dashboard-contract.ts";
import type { ReadRecord } from "../lib/launches.ts";
import { buildLine } from "../lib/line.ts";
import { stationDecision } from "../lib/line-station.ts";
import { type PlanInput, planTick } from "../lib/plan.ts";
import { clearBlock, STRANDED_HOLD_MS } from "../lib/stranded-holds.ts";
import type { Action, DrivenPr } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";
import { planInput } from "./plan-input-fixtures.ts";
import { input as lineInput, PATH, record, report } from "./line-fixtures.ts";

const NOW_MS = parseMs("2026-11-18T22:00:00.000Z");
const PAST = isoFromMs(NOW_MS - STRANDED_HOLD_MS - 60_000);
const RECENT = isoFromMs(NOW_MS - STRANDED_HOLD_MS + 60_000);
const ID = "20261118T120000Z-aaaaaaaa";
const CLAIM_ID = 902;
const REASON = "the supervised stage ended without confirmed cleanup";
const PROCESS = {
  hostId: "h",
  host: "h",
  bootId: "b",
  pid: 1,
  start: "s",
  claimedAt: PAST,
};

const input = (over: Partial<PlanInput>): PlanInput => planInput(NOW_MS, over);

const drive = (heartbeat: string, over: Partial<DrivenPr> = {}): DrivenPr => ({
  number: 7,
  url: `https://github.com/${SLUG}/pull/7`,
  title: "Pull request 7",
  head: "feature/7",
  class: "re-armable",
  why: "stopped HITL_PARKED, every parked item answered",
  evidence: { generation: 3, exit: 8, heartbeat },
  ...over,
});

const launch = (
  state: ReadRecord["state"],
  fields: Partial<ReadRecord["record"]> = {},
): ReadRecord =>
  record({ id: ID, repo: SLUG, pr: 7, createdAt: PAST, ...fields }, state);

const unknown: ReadRecord["state"] = {
  kind: "unknown",
  reason: REASON,
  process: PROCESS,
};

const needsOf = (plan: PlanInput) =>
  planTick(plan).actions.filter(
    (a) => a.stage === "notify" && a.target === "PR #7",
  );

/** Another host's open claim of the drive, made at `at`. */
function claim(at: string): ReadClaim {
  return {
    id: CLAIM_ID,
    stage: "drive",
    login: "maintainer",
    createdAt: at,
    trusted: true,
    says: ok({
      pr: 7,
      attempt: 1,
      at,
      run: "tick",
      action: "rearm",
      record: ID,
      host: "other-host",
      owner: true,
      facts: "stopped 8",
      change: null,
      conflictStop: false,
      end: null,
      legacy: false,
    }),
  };
}

const foreign = (at: string): Partial<PlanInput> => ({
  shared: {
    host: "this-host",
    drives: new Map([[7, ok([claim(at)])]]),
  },
});

describe("a stopped drive held by a launch of unknown process", () => {
  it("raises a need naming the record past the bound, and still reports the drive held", () => {
    const plan = input({ drives: [drive(PAST)], launches: [launch(unknown)] });
    expect(needsOf(plan)).toEqual([
      expect.objectContaining({
        cause: "needs-person",
        reason: expect.stringContaining(ID),
        evidence: expect.objectContaining({ record: ID, stuck: REASON }),
      }),
    ]);
    expect(needsOf(plan)[0]?.notice?.text).toContain(
      `jig dispatch clear ${ID}`,
    );
    expect(planTick(plan).running.map((r) => r.target)).toEqual(["PR #7"]);
  });

  it("raises the need for a stale ledger, a stop with no cause and a stop only a person settles and an arm with no ledger", () => {
    for (const cls of [
      "stale",
      "stopped-unknown",
      "needs-person",
      "unarmed",
    ] as const)
      expect(
        needsOf(
          input({
            drives: [drive(PAST, { class: cls })],
            launches: [launch(unknown)],
          }),
        ).filter((a) => a.evidence.record === ID),
      ).toHaveLength(1);
  });

  it("reports the drive unplaced, with the runtime's reason, while it cannot say which sessions run", () => {
    const plan = planTick(
      input({
        drives: [drive(PAST)],
        launches: [launch(unknown)],
        sessions: {
          ok: false,
          source: "fake",
          reason: "the runtime did not answer",
        },
      }),
    );
    expect(plan.unplaced).toContainEqual({
      target: "PR #7",
      record: "runtime",
      reason: "the runtime did not answer",
    });
  });

  it("frames no clearing for a record a person's answer may not clear, and says what to settle", () => {
    for (const [state, words] of [
      [
        {
          ...unknown,
          liveProcess: { ...PROCESS, pid: 4242 },
        } as ReadRecord["state"],
        "4242 still runs",
      ],
      [
        { ...unknown, unjudged: true } as ReadRecord["state"],
        "could not be judged",
      ],
      [
        { ...unknown, wallUnrecorded: true } as ReadRecord["state"],
        "never recorded",
      ],
    ] as const) {
      const [need] = needsOf(
        input({ drives: [drive(PAST)], launches: [launch(state)] }),
      );
      expect(need?.evidence.stuck).toBeUndefined();
      expect(need?.evidence.blocked).toContain(words);
      expect(need?.notice?.text).toContain(words);
    }
  });

  it("shows the workspace of a need it frames no clearing for", () => {
    const read = launch({ ...unknown, unjudged: true });
    const actions = needsOf(input({ drives: [drive(PAST)], launches: [read] }));
    const line = buildLine(
      lineInput({
        inputs: new Map([
          [
            PATH,
            {
              drives: [],
              known: [],
              sessions: { ok: true, source: "fake", workspaces: [] },
            },
          ],
        ]),
        reports: [report({ slug: SLUG, actions })],
        records: [read],
      }),
    );
    expect(line.needs[0]?.workspaces).toEqual([
      read.record.workspace?.path ?? "",
    ]);
  });

  it("lets an answer clear a record every process of which was judged", () => {
    expect(
      clearBlock({ kind: "unknown", reason: REASON, process: PROCESS }),
    ).toBe(null);
  });

  it("logs its need under no drive outcome, whatever exit the drive stopped on", () => {
    const [need] = needsOf(
      input({ drives: [drive(PAST)], launches: [launch(unknown)] }),
    );
    if (need === undefined) throw new Error("no need raised");
    expect(classOf(need as Parameters<typeof classOf>[0])).toBeNull();
  });

  it("keeps the key of its message from tick to tick", () => {
    const at = (nowMs: number) =>
      needsOf(
        input({
          drives: [drive(PAST)],
          launches: [launch(unknown)],
          nowMs,
        }),
      )[0]?.notice?.key;
    expect(at(NOW_MS)).toBe(at(NOW_MS + 3_600_000));
  });

  it("waits inside the bound, counted from the later of the launch and the stop", () => {
    expect(
      needsOf(input({ drives: [drive(RECENT)], launches: [launch(unknown)] })),
    ).toEqual([]);
    expect(
      needsOf(
        input({
          drives: [drive(PAST)],
          launches: [launch(unknown, { createdAt: RECENT })],
        }),
      ),
    ).toEqual([]);
  });

  it("raises nothing while a holder's process is alive, or for a pending launch", () => {
    const alive: ReadRecord["state"] = { kind: "alive", process: PROCESS };
    for (const launches of [
      [launch(alive)],
      [launch(unknown), launch(alive, { id: "20261118T130000Z-bbbbbbbb" })],
      [launch({ kind: "pending" }, { attempts: [] })],
    ])
      expect(
        needsOf(input({ drives: [drive(PAST)], launches })).filter(
          (a) => a.evidence.stuck === REASON,
        ),
      ).toEqual([]);
  });

  it("raises nothing for a stop the hold does not keep from a launch", () => {
    for (const cls of ["done", "stopped-by-person", "parked"] as const)
      expect(
        needsOf(
          input({
            drives: [drive(PAST, { class: cls })],
            launches: [launch(unknown)],
          }),
        ).filter((a) => a.evidence.stuck === REASON),
      ).toEqual([]);
  });

  it("waits while the runtime cannot say which sessions run", () => {
    expect(
      needsOf(
        input({
          drives: [drive(PAST)],
          launches: [launch(unknown)],
          sessions: {
            ok: false,
            source: "fake",
            reason: "the runtime did not answer",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("raises a need naming another host's open claim past the bound, and offers no record to clear", () => {
    const [need] = needsOf(input({ drives: [drive(PAST)], ...foreign(PAST) }));
    expect(need?.reason).toContain(`launch claim ${CLAIM_ID}`);
    expect(need?.reason).toContain("other-host");
    expect(need).toMatchObject({
      cause: "needs-person",
      evidence: { heldClaim: String(CLAIM_ID), host: "other-host" },
    });
    expect(need?.evidence.stuck).toBeUndefined();
    expect(need?.notice?.text).not.toContain("jig dispatch clear");
  });

  it("waits inside the bound for another host's claim", () => {
    expect(
      needsOf(input({ drives: [drive(PAST)], ...foreign(RECENT) })),
    ).toEqual([]);
  });
});

describe("a drive that waits on a person, held by another host's claim", () => {
  const waiting = () => drive(PAST, { class: "needs-person" });

  it("is not notified of inside the bound, and raises the hold's need past it", () => {
    expect(needsOf(input({ drives: [waiting()], ...foreign(RECENT) }))).toEqual(
      [],
    );
    const [need] = needsOf(input({ drives: [waiting()], ...foreign(PAST) }));
    expect(need).toMatchObject({
      cause: "needs-person",
      evidence: { heldClaim: String(CLAIM_ID), heldSince: PAST },
    });
  });

  it("still notifies when no claim of another host holds it", () => {
    const [need] = needsOf(
      input({
        drives: [waiting()],
        shared: { host: "this-host", drives: new Map([[7, ok([])]]) },
      }),
    );
    expect(need?.cause).toBe("needs-person");
    expect(need?.evidence.heldClaim).toBeUndefined();
  });
});

describe("the decision a stranded hold frames", () => {
  const framed = (action: Action) =>
    stationDecision(action as Action & { cause: NeedCause }, {
      slug: SLUG,
      itemsOnForge: true,
      issueRepository: SLUG,
      carriedBy: () => [],
    });

  it("offers clearing this machine's record, saying what holds the drive", () => {
    const [need] = needsOf(
      input({ drives: [drive(PAST)], launches: [launch(unknown)] }),
    );
    if (need === undefined) throw new Error("no need raised");
    const decision = framed(need);
    expect(decision?.key).toBe("launch");
    expect(decision?.decision?.alreadyDone).toContain(REASON);
    expect(decision?.decision?.alreadyDone).not.toContain("is pending");
  });

  it("offers nothing for a record it may not clear", () => {
    const [need] = needsOf(
      input({
        drives: [drive(PAST)],
        launches: [launch({ ...unknown, unjudged: true })],
      }),
    );
    if (need === undefined) throw new Error("no need raised");
    expect(framed(need)).toBeNull();
  });

  it("offers nothing for another host's claim, which is settled there", () => {
    const [need] = needsOf(input({ drives: [drive(PAST)], ...foreign(PAST) }));
    if (need === undefined) throw new Error("no need raised");
    expect(framed(need)).toBeNull();
  });
});
