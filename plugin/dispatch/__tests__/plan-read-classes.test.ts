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
  it("is still reported to a person, and never taken over", () => {
    const plan = planTick(
      input({
        drives: [
          drive({
            class: "silent",
            why: "its driver is silent",
            evidence: {
              started: "2026-11-15T06:00:00Z",
              trustedDriveManual: true,
            },
          }),
        ],
      }),
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
  });
});
