/**
 * A person who answers a stalled pickup's question by choosing to wait for a
 * merge leaves a conditional hold, not a step.
 */
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { failed, ok } from "../../shared/outcome.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import { stationContextOf } from "../lib/line-station.ts";
import { personPickupHolds } from "../lib/person-pickup-holds.ts";
import { closeStateDb } from "../lib/state.ts";
import { takeCarried } from "../lib/station-answer-store.ts";
import {
  settleStationAnswers,
  type StationPorts,
} from "../lib/station-answers.ts";
import type { Action } from "../lib/types.ts";
import { report as reportOf } from "./line-fixtures.ts";

const SLUG = "example-org/web";
const LINEAR = stationContextOf(SLUG, {
  tracker: { adapter: "linear" },
  links: { itemsOf: () => null, prsOf: () => [] },
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const option = (id: string, name: string) => ({
  id,
  name,
  summary: `${name}.`,
  pay: ["It costs time."],
});

it("places a conditional hold when the person chooses to wait for a merge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-answers-hold-"));
  dirs.push(dir);
  const decision: ParkedDecision = {
    schema: "parked-decision/v1",
    class: "scope",
    call: {
      id: "a",
      question: "When should the pickup resume?",
      options: [
        option("wait", "Wait for #23 to merge"),
        option("now", "Resume now"),
      ],
      recommended: "wait",
      why: "The dependency changes the code this pickup needs.",
    },
    steps: [],
    alreadyDone: "The pickup checked the dependency.",
  };
  const digest = decisionDigest(decision);
  const action: Action = {
    stage: "notify",
    target: "ENG-12",
    record: "tracker",
    reason: "stalled pickup",
    cause: "pickup-question",
    evidence: { record: "pickup-1", question: decision.call.question },
    framed: { decision, digest, at: "2026-11-12T10:00:00.000Z" },
  };
  const answer: CommentLike = {
    author: "Dana Lee",
    association: "MEMBER",
    at: "2026-11-12T11:00:00Z",
    editedAt: null,
    url: "https://linear.app/acme/issue/ENG-12/x#comment-1",
    body: `answer pickup: approve [${digest}]`,
  };
  const steps: string[] = [];
  const never = async (...args: unknown[]) => {
    steps.push(args.join(" "));
    return ok("done it");
  };
  const ports: StationPorts = {
    self: "drive-bot",
    issueRepository: SLUG,
    comments: async () => failed("unreadable", "the forge was read"),
    trackerComments: async () =>
      ok({ comments: [answer], own: { name: "Jig Factory", comments: [] } }),
    rerunFollowup: never,
    doneFollowup: never,
    releasePickup: never,
    detachCheckout: never,
    rearmDrive: never,
    clearRecord: never,
  };
  await settleStationAnswers(
    SLUG,
    reportOf({ actions: [action] }),
    LINEAR,
    ports,
    dir,
  );
  expect(steps).toEqual([]);
  expect(personPickupHolds(SLUG, dir)).toMatchObject({
    ok: true,
    value: [
      {
        item: "ENG-12",
        condition: { kind: "pr-merged", pr: 23 },
        resumeRecord: "pickup-1",
      },
    ],
  });
  expect(takeCarried(SLUG, "ENG-12", "r-1", dir)).toBeNull();
});
