/**
 * A person's answer to a need's decision: counted only from a trusted
 * author other than the dispatcher, naming the decision's current digest,
 * agreed by every person who answered; its step runs once, refuses with
 * why, and a step that starts a session leaves that session the answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import { stationContextOf, stationDecision } from "../lib/line-station.ts";
import { closeStateDb } from "../lib/state.ts";
import {
  claimAnswer,
  type CarriedAnswer,
  takeCarried,
} from "../lib/station-answer-store.ts";
import {
  settleStationAnswers,
  type StationPorts,
} from "../lib/station-answers.ts";
import type { Action, RepoReport } from "../lib/types.ts";
import { report as reportOf } from "./line-fixtures.ts";

const SLUG = "example-org/web";
const CONTEXT = stationContextOf(SLUG, { tracker: { adapter: "github" } });

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "station-answers-"));
  roots.push(dir);
  return dir;
}

function failedFollowup(): Action {
  return {
    stage: "notify",
    target: "PR #12",
    record: "forge",
    reason: "failed follow-up",
    cause: "followup-failed",
    evidence: { marker: 41, record: "20261112T101301Z-33c6fa5f" },
  };
}

const digestOf = (action: Action) =>
  stationDecision(action as Action & { cause: "followup-failed" }, CONTEXT)
    ?.digest ?? "";

let next = 1;
function said(
  body: string,
  author = "maintainer",
  association = "OWNER",
  at = "2026-11-12T11:00:00Z",
): CommentLike {
  next += 1;
  return {
    author,
    association,
    at,
    editedAt: null,
    url: `https://github.com/${SLUG}/pull/12#issuecomment-${next}`,
    body,
  };
}

/** Ports that record each step and answer as told. */
function ports(
  comments: CommentLike[],
  answer: Outcome<string, "refused"> = ok("done it"),
): StationPorts & { steps: string[] } {
  const steps: string[] = [];
  const step =
    (name: string) =>
    async (...args: unknown[]) => {
      steps.push(`${name} ${args.join(" ")}`);
      return answer;
    };
  return {
    steps,
    self: "drive-bot",
    issueRepository: SLUG,
    comments: async () => ok(comments),
    rerunFollowup: step("rerun"),
    doneFollowup: step("done"),
    releasePickup: step("release"),
    detachCheckout: step("detach"),
    rearmDrive: step("rearm"),
    clearRecord: step("clear"),
  };
}

function settle(
  report: RepoReport,
  p: StationPorts,
  dir: string,
): Promise<void> {
  return settleStationAnswers(SLUG, report, CONTEXT, p, dir);
}

describe("settleStationAnswers", () => {
  it("runs the chosen option's step once, keeps how it went, and hands the next session the answer", async () => {
    const dir = root();
    const action = failedFollowup();
    const digest = digestOf(action);
    const comment = said(`answer followup: approve [${digest}]`);
    const p = ports([comment]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(report.actions[0]?.answered).toMatchObject({
      digest,
      answers: [{ author: "maintainer", choice: { option: "Run it again" } }],
      acted: { option: "Run it again", outcome: "done", detail: "done it" },
    });
    // The next tick reads the same answer: its step has run.
    const again = reportOf({ actions: [failedFollowup()] });
    await settle(again, p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(again.actions[0]?.answered?.acted?.outcome).toBe("done");
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toMatchObject({
      option: "Run it again",
      recommended: true,
      by: "maintainer",
      url: comment.url,
    });
    expect(takeCarried(SLUG, "PR #12", "r-2", dir)).toBeNull();
  });

  it("keeps the answer the next session is handed when the tick dies between the step's effect and its outcome", async () => {
    const dir = root();
    const action = failedFollowup();
    const comment = said(`answer followup: approve [${digestOf(action)}]`);
    const p = ports([comment]);
    p.rerunFollowup = async () => {
      throw new Error("the tick died after the marker was deleted");
    };
    await expect(
      settle(reportOf({ actions: [action] }), p, dir),
    ).rejects.toThrow("died");
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toMatchObject({
      option: "Run it again",
      url: comment.url,
    });
  });

  it("acts on no answer from the dispatcher's own login or an author the forge does not vouch for", async () => {
    const dir = root();
    const action = failedFollowup();
    const digest = digestOf(action);
    const p = ports([
      said(`answer followup: approve [${digest}]`, "drive-bot"),
      said(`answer followup: approve [${digest}]`, "passer-by", "NONE"),
    ]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual([]);
    expect(report.actions[0]?.answered?.answers).toEqual([]);
  });

  it("leaves an answer naming no digest, or another, stale, and two people's different options disputed", async () => {
    const dir = root();
    const digest = digestOf(failedFollowup());
    const stale = reportOf({ actions: [failedFollowup()] });
    const unbound = ports([said("answer followup: approve")]);
    await settle(stale, unbound, dir);
    expect(stale.actions[0]?.answered?.state).toBe("stale");
    const disputed = reportOf({ actions: [failedFollowup()] });
    const two = ports([
      said(`answer followup: approve [${digest}]`),
      said(
        `answer followup: choose Leave it to me [${digest}]`,
        "another-owner",
      ),
    ]);
    await settle(disputed, two, dir);
    expect(disputed.actions[0]?.answered?.state).toBe("disputed");
    expect([...unbound.steps, ...two.steps]).toEqual([]);
  });

  it("keeps a need answered Leave it to me off the needs for its facts, with no step", async () => {
    const dir = root();
    const action = failedFollowup();
    const p = ports([
      said(`answer followup: choose leave it to me [${digestOf(action)}]`),
    ]);
    const report = reportOf({ actions: [action] });
    await settle(report, p, dir);
    expect(p.steps).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(report.quiet).toEqual([
      expect.objectContaining({ target: "PR #12", class: "answered-hold" }),
    ]);
  });

  it("keeps a refused step's reason, and runs it again only for a new answer", async () => {
    const dir = root();
    const digest = digestOf(failedFollowup());
    const first = said(`answer followup: approve [${digest}]`);
    const refusing = ports(
      [first],
      failed("refused", "a person's hold label is on PR #12"),
    );
    const report = reportOf({ actions: [failedFollowup()] });
    await settle(report, refusing, dir);
    expect(report.actions[0]?.answered?.acted).toMatchObject({
      outcome: "refused",
      detail: "a person's hold label is on PR #12",
    });
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toBeNull();
    await settle(reportOf({ actions: [failedFollowup()] }), refusing, dir);
    expect(refusing.steps).toHaveLength(1);
    const answeredAgain = ports([
      first,
      said(
        `answer followup: approve [${digest}]`,
        "maintainer",
        "OWNER",
        "2026-11-12T12:00:00Z",
      ),
    ]);
    await settle(reportOf({ actions: [failedFollowup()] }), answeredAgain, dir);
    expect(answeredAgain.steps).toEqual(["rerun 12 41"]);
  });

  it("starts a pass's own decision's stage again and hands its next session the option chosen", async () => {
    const dir = root();
    const decision: ParkedDecision = {
      schema: "parked-decision/v1",
      class: "scope",
      call: {
        id: "a",
        question: "Should the export keep the old column?",
        options: [
          {
            id: "keep",
            name: "Keep it",
            summary: "The column stays.",
            pay: ["A wider export."],
          },
          {
            id: "drop",
            name: "Drop it",
            summary: "The column goes.",
            pay: ["Readers of it break."],
          },
        ],
        recommended: "keep",
        why: "Readers of the column still exist.",
      },
      steps: [],
      alreadyDone: "The scouts ran.",
    };
    const digest = decisionDigest(decision);
    const action: Action = {
      ...failedFollowup(),
      framed: { decision, digest, at: "2026-11-12T10:00:00.000Z" },
    };
    const p = ports([
      said(
        `answer followup: choose Drop it [${digest}]\nnote followup: only the export's copy`,
      ),
    ]);
    await settle(reportOf({ actions: [action] }), p, dir);
    expect(p.steps).toEqual(["rerun 12 41"]);
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)).toMatchObject({
      question: "Should the export keep the old column?",
      option: "Drop it",
      recommended: false,
      changes: "The column goes.",
      note: "only the export's copy",
    });
  });

  it("retires an interrupted answer's carry when a newer answer to the same decision is claimed", () => {
    const dir = root();
    const carry = (option: string): CarriedAnswer => ({
      question: "q?",
      option,
      recommended: false,
      changes: "",
      costs: "",
      by: "maintainer",
      url: `https://github.com/${SLUG}/pull/12#issuecomment-${option}`,
    });
    const row = (answer: string, option: string) => ({
      repo: SLUG,
      target: "PR #12",
      key: "followup",
      digest: "d1",
      answer,
      author: "maintainer",
      option,
    });
    expect(claimAnswer(row("a 1", "First"), carry("First"), dir)).toBe(true);
    expect(claimAnswer(row("b 2", "Second"), carry("Second"), dir)).toBe(true);
    expect(takeCarried(SLUG, "PR #12", "r-1", dir)?.option).toBe("Second");
    expect(takeCarried(SLUG, "PR #12", "r-2", dir)).toBeNull();
  });
});
