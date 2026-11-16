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
import { dispatchSection } from "../lib/section.ts";
import type { DispatchSection, DrivenPr, MarkedPr } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";

const NOW = Date.parse("2026-11-15T08:00:00Z");

function section(): DispatchSection {
  const read = dispatchSection({
    issue_tracker: { adapter: "github", github: { repository: SLUG } },
    dispatch: { identity: "factory-bot", followup_command: "/followup" },
  });
  if (!read.ok) throw new Error(read.failure.reason);
  return read.value;
}

function input(over: Partial<PlanInput>): PlanInput {
  return {
    slug: SLUG,
    section: section(),
    pickups: [],
    claimed: [],
    drives: [],
    merged: [],
    outcomes: new Map(),
    sessions: { ok: true, source: "fake", workspaces: [] },
    launches: [],
    idleSince: new Map(),
    nowMs: NOW,
    ...over,
  };
}

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
