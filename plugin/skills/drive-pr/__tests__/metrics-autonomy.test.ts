/**
 * The loop-metrics counters of what a drive did without a person, per pull
 * request: provisional decisions and how many a person reversed before the
 * merge (the validation measure for `wide`), review-bot chat
 * acknowledgements, self-restarts and re-arms by cause, and takeovers.
 */
import { describe, expect, it } from "bun:test";
import { botMarkers } from "../scripts/lib/bot-confirmation.ts";
import {
  autonomyMetrics,
  renderAutonomyMetrics,
  threadAutonomy,
} from "../scripts/lib/metrics-autonomy.ts";
import type { PrSample } from "../scripts/lib/sample.ts";
import { runReport } from "../scripts/loop-metrics.ts";
import { provisionalBody } from "../scripts/provisional-reply.ts";
import { commentNodes } from "./provisional-fixtures.ts";

const BOTS = botMarkers(["coderabbitai[bot]"]);
const FINDING = {
  author: "review-bot[bot]",
  association: "NONE",
  body: "Raise the budget.",
};
const PROVISIONAL = {
  author: "operator",
  association: "MEMBER",
  body: provisionalBody("**rejected** — the budget is policy.", "escalated"),
};
const CHAT = {
  author: "coderabbitai",
  association: "NONE",
  body: "Understood, nothing further.\n<!-- coderabbit-ai-generated:v1 -->",
};
const at = (hour: number) =>
  new Date(Date.UTC(2026, 9, 27, hour)).toISOString();

function thread(comments: Array<typeof FINDING & { at?: string }>) {
  return {
    autonomy: threadAutonomy(commentNodes("PRRT_x", comments), false, BOTS),
  };
}

describe("one thread's counters", () => {
  it("count a provisional reply, its reversal by a person, and chat acknowledgements", () => {
    const t = thread([
      FINDING,
      PROVISIONAL,
      CHAT,
      {
        author: "lead",
        association: "OWNER",
        body: "Fix it instead.",
        at: at(5),
      },
    ]).autonomy;
    expect(t).toEqual({
      provisional: true,
      reversedAt: at(5),
      chatAcknowledgements: 1,
    });
  });

  it("read nothing from a truncated thread, and no reversal from a bot or an untrusted author", () => {
    expect(
      threadAutonomy(commentNodes("PRRT_x", [FINDING, PROVISIONAL]), true, BOTS)
        .provisional,
    ).toBe(false);
    const t = thread([
      FINDING,
      PROVISIONAL,
      CHAT,
      { author: "drive-by", association: "NONE", body: "Disagree." },
    ]).autonomy;
    expect(t.reversedAt).toBeNull();
  });
});

describe("the per-pull-request counters and the measure", () => {
  const reversedEarly = thread([
    FINDING,
    PROVISIONAL,
    { author: "lead", association: "OWNER", body: "No.", at: at(2) },
  ]);
  const reversedLate = thread([
    FINDING,
    PROVISIONAL,
    { author: "lead", association: "OWNER", body: "No.", at: at(9) },
  ]);
  const standing = thread([FINDING, PROVISIONAL, CHAT]);
  const plain = thread([FINDING]);

  it("count only reversals before the merge, and take the durable record's restarts, re-arms and takeovers", () => {
    const m = autonomyMetrics(
      [reversedEarly, reversedLate, standing, plain],
      at(6),
      {
        decisions: [
          {
            at: at(1),
            round: 1,
            level: "wide",
            class: "decide-provisional",
            what: "kept one parser",
            record: "https://example.invalid/c/1",
            reverse: "answer the record",
            key: "parser-split",
            reversed: {
              at: at(3),
              by: "lead",
              url: "https://example.invalid/c/2",
            },
          },
        ],
        events: [
          { at: at(1), round: 1, kind: "restart", cause: "pass-deadline" },
          { at: at(2), round: 2, kind: "restart", cause: "pass-deadline" },
          { at: at(3), round: 2, kind: "restart", cause: "stall" },
          { at: at(4), round: 3, kind: "rearm", cause: "provisional" },
        ],
        takeovers: 1,
      },
    );
    expect(m).toEqual({
      provisional: 4,
      reversedBeforeMerge: 2,
      reversedShare: 0.5,
      transparentAcknowledgements: 1,
      restarts: { "pass-deadline": 2, stall: 1 },
      rearms: { provisional: 1 },
      takeovers: 1,
    });
    const lines = renderAutonomyMetrics(m).join("\n");
    expect(lines).toContain(
      "4 provisional decision(s), 2 reversed by a person before the merge (50.0%",
    );
    expect(lines).toContain("self-restarts: pass-deadline 2 · stall 1");
    expect(lines).toContain("re-arms: provisional 1");
  });

  it("counts every reversal so far on an open pull request, and says when the clone holds no state", () => {
    const m = autonomyMetrics(
      [reversedEarly, reversedLate, standing],
      null,
      null,
    );
    expect(m.reversedBeforeMerge).toBe(2);
    expect(m.restarts).toBeNull();
    expect(renderAutonomyMetrics(m).join("\n")).toContain(
      "takeovers: not held in this clone",
    );
  });

  it("loop-metrics.ts writes them beside the loop economy, from the threads and this clone's drive state", async () => {
    const written: string[] = [];
    await runReport("1", false, {
      resolveRepo: async () => ({ owner: "example-org", name: "example-repo" }),
      samplePr: async () =>
        ({
          pr: 1,
          title: "a pr",
          state: "MERGED",
          additions: 0,
          deletions: 0,
          changedFiles: 0,
          baseRefName: "main",
          headRefOid: "h",
          createdAt: at(0),
          mergedAt: at(6),
          mergeCommitOid: "",
          commits: [],
          reviews: [],
          threads: [reversedEarly, standing].map((t) => ({
            threadId: "t",
            path: "a.ts",
            line: 1,
            originalLine: null,
            diffSide: "RIGHT",
            isOutdated: false,
            isResolved: true,
            startedBy: "review-bot",
            startedByBot: true,
            url: null,
            outcome: "rejected",
            reason: "policy",
            settledBody: null,
            createdAt: at(0),
            settledAt: at(1),
            commentsTruncated: false,
            category: "unknown",
            severity: "medium",
            reviewedHeadOid: null,
            autonomy: t.autonomy,
          })),
        }) as PrSample,
      durableRounds: async () => 3,
      durableAutonomy: async () => ({
        decisions: [],
        events: [{ at: at(1), round: 1, kind: "rearm", cause: "answered" }],
        takeovers: 0,
      }),
      resolveSiblingCommitOids: async () => new Set<string>(),
      resolveEscapeBaseline: async () => null,
      write: (s) => {
        written.push(s);
      },
    });
    expect(written[0]).toContain(
      "autonomy   2 provisional decision(s), 1 reversed by a person before the merge (50.0%",
    );
    expect(written[0]).toContain("re-arms: answered 1");
  });

  it("prints nothing for a drive that did nothing without a person", () => {
    expect(renderAutonomyMetrics(autonomyMetrics([plain], null, null))).toEqual(
      [],
    );
    expect(autonomyMetrics([plain], null, null).reversedShare).toBeNull();
  });
});
