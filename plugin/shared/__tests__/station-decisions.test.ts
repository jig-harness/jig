/**
 * The decisions the tick frames for the line's needs: each passes the check
 * a drive's park passes, recommends by the facts, keeps its digest while its
 * facts stand, and is answered by a `jig send` command that names its
 * station's address, its key and the framing's digest.
 */
import { describe, expect, it } from "bun:test";
import { actOfClass } from "../acts.ts";
import { decisionDigest } from "../decisions/digest.ts";
import { checkParkedDecision } from "../decisions/park.ts";
import {
  frameStationDecision,
  STATION_CLASSES,
  type StationFacts,
  stationOptionId,
  stationSendCommand,
} from "../decisions/station.ts";

const EVERY: StationFacts[] = [
  {
    kind: "followup-failed",
    pr: 12,
    record: "20261112T101301Z-33c6fa5f",
    marker: 6820798660,
    question: null,
  },
  {
    kind: "followup-failed",
    pr: 12,
    record: null,
    marker: null,
    question: "Which consumer repositories should receive the migration?",
  },
  { kind: "followup-stale", pr: 12, marker: 41, released: 40 },
  { kind: "stalled", item: "#513", state: "In Progress", carriedBy: [] },
  { kind: "stalled", item: "ENG-4", state: "In Progress", carriedBy: null },
  {
    kind: "pickup-question",
    item: "#604",
    record: "20261112T071321Z-0c6b9be4",
    question: "Should #604 stay medium, or go in its own pull request?",
  },
  {
    kind: "checkout",
    target: "PR #879",
    branch: "docs/plan",
    path: "/srv/work/web-plan",
  },
  {
    kind: "drive",
    pr: 5376,
    exit: "1",
    started: "2026-11-10T09:00:00.000Z",
    failedRearm: null,
  },
  { kind: "drive", pr: 7, exit: null, started: null, failedRearm: "r-1" },
  { kind: "launch", target: "PR #7", record: "20261110T151827Z-f17108e4" },
];

const recommendedName = (facts: StationFacts) => {
  const { call } = frameStationDecision(facts).decision;
  return call.options.find((o) => o.id === call.recommended)?.name;
};

describe("frameStationDecision", () => {
  it("frames every cause as a decision a park's check accepts, under a class the acts table lists as Decide", () => {
    for (const facts of EVERY) {
      const { key, decision } = frameStationDecision(facts);
      expect(checkParkedDecision(decision, decision.class)).toEqual([]);
      expect(decision.class).toBe(STATION_CLASSES[key]);
      expect(actOfClass(decision.class)).toBe("Decide");
      expect(decision.call.options.at(-1)?.name).toBe("Leave it to me");
      for (const option of decision.call.options)
        expect(stationOptionId(option.name)).toBe(
          option.id as ReturnType<typeof stationOptionId>,
        );
    }
  });

  it("keeps the digest while the facts stand, and changes it with the occurrence", () => {
    const [first] = EVERY;
    if (first?.kind !== "followup-failed") throw new TypeError("fixture");
    const digest = decisionDigest(frameStationDecision(first).decision);
    expect(decisionDigest(frameStationDecision({ ...first }).decision)).toBe(
      digest,
    );
    expect(
      decisionDigest(
        frameStationDecision({ ...first, record: "20261112T111301Z-00000000" })
          .decision,
      ),
    ).not.toBe(digest);
  });

  it("recommends running a follow-up again only when its pass asked nothing", () => {
    expect(recommendedName(EVERY[0] as StationFacts)).toBe("Run it again");
    expect(recommendedName(EVERY[1] as StationFacts)).toBe("Leave it to me");
    expect(
      frameStationDecision(EVERY[1] as StationFacts).decision.alreadyDone,
    ).toContain('"Which consumer repositories should receive the migration?"');
  });

  it("recommends releasing a stalled pickup only when no open pull request is known to carry it", () => {
    const stalled = {
      kind: "stalled",
      item: "#770",
      state: "In Progress",
    } as const;
    expect(recommendedName({ ...stalled, carriedBy: [] })).toBe(
      "Release the claim",
    );
    expect(recommendedName({ ...stalled, carriedBy: [793] })).toBe(
      "Leave it to me",
    );
    expect(recommendedName({ ...stalled, carriedBy: null })).toBe(
      "Leave it to me",
    );
    expect(
      frameStationDecision({ ...stalled, carriedBy: [793] }).decision
        .alreadyDone,
    ).toContain("#793");
  });

  it("leaves a busy checkout and a stopped drive to a person, and clears a stuck record", () => {
    expect(recommendedName(EVERY[6] as StationFacts)).toBe("Leave it to me");
    expect(recommendedName(EVERY[7] as StationFacts)).toBe("Leave it to me");
    expect(recommendedName(EVERY[9] as StationFacts)).toBe("Clear the record");
  });
});

describe("stationSendCommand", () => {
  it("names the address, the key, the form and the digest", () => {
    const answer = { address: "followup@example-org/web#12" };
    expect(
      stationSendCommand(
        answer,
        "followup",
        { form: "approve" },
        "3fa9c2d1e0b4",
      ),
    ).toBe(
      "jig send followup@example-org/web#12 answer followup --approve --decision 3fa9c2d1e0b4",
    );
    expect(
      stationSendCommand(
        { address: "pickup@example-org/web#ENG-4" },
        "pickup",
        { form: "choose", option: "Release the claim" },
        "3fa9c2d1e0b4",
        "after the release, not before",
      ),
    ).toBe(
      "jig send pickup@example-org/web#ENG-4 answer pickup --choose 'Release the claim' --note 'after the release, not before' --decision 3fa9c2d1e0b4",
    );
    expect(
      stationSendCommand(answer, "followup", {
        form: "choose",
        option: "Don't run",
      }),
    ).toBe(
      "jig send followup@example-org/web#12 answer followup --choose 'Don'\\''t run'",
    );
  });
});
