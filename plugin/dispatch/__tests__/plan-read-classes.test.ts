/**
 * dispatch: the plan keeps the failure class of a read for one item on the
 * item's unplaced row: a drive whose comments, park answers or base branch
 * did not read, another host's launch claims on it, and a merged pull
 * request's follow-up markers. A read no call failed carries none.
 */
import { describe, expect, it } from "bun:test";
import { failedBy, outboundFailure } from "../../shared/outbound/failure.ts";
import { failed, type Outcome } from "../../shared/outcome.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import { factsOf } from "../lib/actions/drive-hold.ts";
import { type PlanInput, planTick } from "../lib/plan.ts";
import type { DrivenPr, MarkedPr } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";
import { planInput } from "./plan-input-fixtures.ts";

const NOW = Date.parse("2026-11-15T08:00:00Z");

const input = (over: Partial<PlanInput>): PlanInput => planInput(NOW, over);

const drive = (over: Partial<DrivenPr>): DrivenPr => ({
  number: 7,
  url: `https://github.com/${SLUG}/pull/7`,
  title: "Pull request 7",
  head: "feature/7",
  class: "unplaced",
  why: "the comments could not be read",
  evidence: {},
  ...over,
});

const merged = (markers: MarkedPr["markers"]): MarkedPr => ({
  number: 5,
  url: `https://github.com/${SLUG}/pull/5`,
  title: "Pull request 5",
  head: "feature/5",
  mergedAt: "2026-11-15T07:00:00Z",
  markers,
});

const rowOf = (input: PlanInput, target: string) =>
  planTick(input).unplaced.find((u) => u.target === target);

describe("the plan of an item whose read a failed call stopped", () => {
  it("keeps a drive's class on its row, and none for a ledger that does not parse", () => {
    expect(
      rowOf(
        input({
          drives: [
            drive({ readFailed: true, failure: { class: "rate-limited" } }),
          ],
        }),
        "PR #7",
      ),
    ).toMatchObject({ readFailed: true, failure: { class: "rate-limited" } });
    expect(
      rowOf(input({ drives: [drive({ readFailed: true })] }), "PR #7")?.failure,
    ).toBeUndefined();
  });

  it("keeps the class of a failed call that stopped another host's launch claims, and none for claims no call failed", () => {
    const silent = drive({
      class: "silent",
      why: "its driver is silent",
      evidence: { started: "2026-11-15T06:00:00Z" },
    });
    const claims = (outcome: Outcome<SharedClaim[], "unreadable">) =>
      input({
        drives: [silent],
        shared: { host: "this-host", drives: new Map([[7, outcome]]) },
      });
    expect(
      rowOf(
        claims(
          failedBy(
            "unreadable",
            outboundFailure("unreachable", "no answer"),
            "the comments could not be read",
          ),
        ),
        "PR #7",
      ),
    ).toMatchObject({ readFailed: true, failure: { class: "unreachable" } });
    expect(
      rowOf(claims(failed("unreadable", "not read")), "PR #7"),
    ).toMatchObject({ readFailed: true });
    expect(
      rowOf(claims(failed("unreadable", "not read")), "PR #7")?.failure,
    ).toBeUndefined();
  });

  it("places a drive waiting on a person as unplaced when another host's claims could not be read", () => {
    const waiting = drive({ class: "needs-person", why: "waits on a person" });
    expect(
      rowOf(
        input({
          drives: [waiting],
          shared: {
            host: "this-host",
            drives: new Map([[7, failed("unreadable", "not read")]]),
          },
        }),
        "PR #7",
      ),
    ).toMatchObject({ readFailed: true });
  });

  it("keeps the class of a failed call that stopped a merged pull request's follow-up markers", () => {
    expect(
      rowOf(
        input({
          merged: [
            merged({
              unreadable: "the comments could not be read",
              failure: { class: "server-fault" },
            }),
          ],
        }),
        "PR #5",
      ),
    ).toMatchObject({ readFailed: true, failure: { class: "server-fault" } });
    expect(
      rowOf(input({ merged: [merged({ unreadable: "not a list" })] }), "PR #5")
        ?.failure,
    ).toBeUndefined();
  });
});

describe("a silent drive the trusted automation opt-out blocks", () => {
  // A driver no launch started whose run this host shows ended: without the
  // opt-out the planner takes it over.
  const gone = (extra: DrivenPr["evidence"]) =>
    drive({
      class: "silent",
      why: "its driver is silent",
      evidence: {
        started: "2026-11-15T06:00:00Z",
        driverGone: true,
        unlaunched: true,
        driverCheck: "its process ended",
        ...extra,
      },
    });

  it("is taken over without the opt-out", () => {
    const plan = planTick(input({ drives: [gone({})] }));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ stage: "rearm", target: "PR #7" });
    expect(plan.actions[0]?.reason).toContain("take it over");
  });

  it("is still reported to a person, not taken over or left quiet, with the opt-out", () => {
    const plan = planTick(
      input({ drives: [gone({ trustedDriveManual: true })] }),
    );
    expect(plan.quiet.map((q) => q.target)).not.toContain("PR #7");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      stage: "notify",
      target: "PR #7",
    });
    expect(plan.actions[0]?.reason).toContain(
      "dispatch.adopt.trusted_automation",
    );
    expect(plan.actions[0]?.reason).not.toContain("take it over");
    // the person is told: the notice itself, not only the planner's reason
    expect(plan.actions[0]?.cause).toBe("needs-person");
    expect(plan.actions[0]?.notice?.text).toContain(
      "dispatch.adopt.trusted_automation",
    );
    expect(plan.actions[0]?.notice?.text).toContain("manual");
  });

  it("still places another host's open claim on a protected silent drive", () => {
    const silent = gone({ trustedDriveManual: true });
    const at = "2026-11-15T07:00:00Z";
    const held: SharedClaim = {
      id: 1,
      stage: "drive",
      login: "drive-bot",
      createdAt: at,
      trusted: true,
      says: {
        ok: true,
        value: {
          pr: 7,
          attempt: 1,
          at,
          run: "tick",
          action: "rearm",
          record: "launch-1",
          host: "other-host",
          owner: true,
          facts: factsOf(silent),
          change: null,
          conflictStop: false,
          end: null,
          legacy: false,
        },
      },
    };
    const plan = planTick(
      input({
        drives: [silent],
        shared: {
          host: "this-host",
          drives: new Map([[7, { ok: true as const, value: [held] }]]),
        },
      }),
    );
    expect(plan.actions.map((a) => a.stage)).not.toContain("rearm");
    expect(plan.running).toHaveLength(1);
    expect(plan.running[0]).toMatchObject({ target: "PR #7", stage: "rearm" });
    expect(plan.running[0]?.reason).toContain("held by host other-host");
    expect(plan.actions.filter((a) => a.target === "PR #7")).toHaveLength(0);
  });

  it("places an unread claim listing of a protected silent drive as unplaced", () => {
    const plan = planTick(
      input({
        drives: [gone({ trustedDriveManual: true })],
        shared: {
          host: "this-host",
          drives: new Map([[7, failed("unreadable", "not read")]]),
        },
      }),
    );
    expect(plan.unplaced.find((u) => u.target === "PR #7")).toMatchObject({
      readFailed: true,
    });
    expect(plan.actions.filter((a) => a.target === "PR #7")).toHaveLength(0);
  });

  it("leaves a silent idle automation drive quiet, without the opt-out", () => {
    const plan = planTick(
      input({
        drives: [
          drive({
            class: "silent",
            why: "its driver is silent",
            evidence: {
              started: "2026-11-15T06:00:00Z",
              automationIdle: true,
            },
          }),
        ],
      }),
    );
    expect(plan.actions).toHaveLength(0);
    expect(plan.quiet.map((q) => q.target)).toContain("PR #7");
  });
});
