/**
 * The loop-metrics counters of what a drive did without a person, per pull
 * request: provisional decisions and how many a person reversed before the
 * merge (the validation measure for `wide`), review-bot chat
 * acknowledgements, self-restarts and re-arms by cause, and takeovers.
 */
import { describe, expect, it } from "bun:test";
import { botMarkers } from "../scripts/lib/bot-confirmation.ts";
import {
  type DurableAutonomy,
  autonomyMetrics,
  renderAutonomyMetrics,
  threadAutonomy,
} from "../scripts/lib/metrics-autonomy.ts";
import type { PrSample } from "../scripts/lib/sample.ts";
import { runReport } from "../scripts/loop-metrics.ts";
import { provisionalBody } from "../scripts/provisional-reply.ts";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { ledgerFromState, renderLedger } from "../scripts/lib/state/ledger.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { commentNodes, fakeForge, runIn } from "./provisional-fixtures.ts";

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
      incomplete: false,
    });
  });

  it("read nothing from a truncated thread but mark it incomplete, and no reversal from a bot or an untrusted author", () => {
    expect(
      threadAutonomy(
        commentNodes("PRRT_x", [FINDING, PROVISIONAL]),
        true,
        BOTS,
      ),
    ).toMatchObject({ provisional: false, incomplete: true });
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
      incompleteThreads: 0,
      uncheckedRulings: 0,
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

  it("withholds the share while a thread is truncated, never reading it as zeroes", () => {
    const truncated = {
      autonomy: threadAutonomy(
        commentNodes("PRRT_y", [FINDING, PROVISIONAL]),
        true,
        BOTS,
      ),
    };
    const m = autonomyMetrics([standing, truncated], null, null);
    expect(m.incompleteThreads).toBe(1);
    expect(m.reversedShare).toBeNull();
    expect(renderAutonomyMetrics(m).join("\n")).toContain(
      "share withheld: 1 thread(s) too long to read whole",
    );
  });

  it("prints nothing for a drive that did nothing without a person", () => {
    expect(renderAutonomyMetrics(autonomyMetrics([plain], null, null))).toEqual(
      [],
    );
    expect(autonomyMetrics([plain], null, null).reversedShare).toBeNull();
  });
});

describe("the durable record loop-metrics.ts reads", () => {
  it("falls back to the pull request's drive ledger when this clone holds no state", async () => {
    const forge = fakeForge("");
    forge.write("login", "drive-bot");
    const ledger = renderLedger(
      ledgerFromState(
        {
          ...freshState(12),
          rounds: 3,
          events: [{ at: at(1), round: 1, kind: "rearm", cause: "answered" }],
          takeovers: [],
        },
        {
          generation: 2,
          driver: {
            actor: "wt-cccccccccccccccc",
            clone: "clone-b",
            heartbeat: at(2),
            state: "stopped",
            exit: 0,
          },
          narrative: [],
          claims: [],
        },
      ),
    );
    if ("error" in ledger) throw new Error(ledger.error);
    forge.write("comments-12.json", [
      {
        id: 120,
        body: ledger.body,
        user: { login: "drive-bot" },
        author_association: "NONE",
        updated_at: at(2),
        created_at: at(2),
        html_url: "https://example.invalid/comment-120",
      },
    ]);
    const r = await runIn(forge, "-e", [
      `import(${JSON.stringify(join(import.meta.dir, "..", "scripts", "loop-metrics.ts"))}).then(async (m) => console.log(JSON.stringify(await m.durableAutonomy("12"))))`,
    ]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      events: [{ kind: "rearm", cause: "answered" }],
      takeovers: 0,
    });
  });

  /** A stopped drive's ledger holding one standing provisional `decide` ruling. */
  const rulingLedger = (): string => {
    const ledger = renderLedger(
      ledgerFromState(
        {
          ...freshState(12),
          rounds: 3,
          decisions: [
            {
              at: at(1),
              round: 2,
              level: "wide",
              class: "decide-provisional",
              what: "kept the retry budget",
              record: "https://example.invalid/comment-110",
              reverse: "answer budget: on the pull request",
              key: "budget",
            },
          ],
        },
        {
          generation: 2,
          driver: {
            actor: "wt-cccccccccccccccc",
            clone: "clone-b",
            heartbeat: at(2),
            state: "stopped",
            exit: 0,
          },
          narrative: [],
          claims: [],
        },
      ),
    );
    if ("error" in ledger) throw new Error(ledger.error);
    return ledger.body;
  };
  const ledgerComment = (body: string) => ({
    id: 120,
    body,
    user: { login: "drive-bot" },
    author_association: "NONE",
    updated_at: at(2),
    created_at: at(2),
    html_url: "https://example.invalid/comment-120",
  });

  it("reads a provisional ruling's reversal from the conversation, after the drive stopped", async () => {
    const forge = fakeForge("");
    forge.write("login", "drive-bot");
    forge.write("comments-12.json", [
      ledgerComment(rulingLedger()),
      {
        id: 130,
        body: "answer budget: raise it after all",
        user: { login: "lead" },
        author_association: "OWNER",
        updated_at: at(3),
        created_at: at(3),
        html_url: "https://example.invalid/comment-130",
      },
    ]);
    const r = await runIn(forge, "-e", [
      `import(${JSON.stringify(join(import.meta.dir, "..", "scripts", "loop-metrics.ts"))}).then(async (m) => console.log(JSON.stringify(await m.durableAutonomy("12"))))`,
    ]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).decisions[0].reversed).toMatchObject({
      by: "lead",
      url: "https://example.invalid/comment-130",
    });
  });

  it("withholds the share while the conversation a ruling's reversal is read from is unreadable", async () => {
    const forge = fakeForge("");
    forge.write("login", "drive-bot");
    forge.write("comments-12.json", [ledgerComment(rulingLedger())]);
    // The ledger read succeeds; the conversation read after it fails.
    forge.write("fail-comments-after", "1");
    const r = await runIn(forge, "-e", [
      `import(${JSON.stringify(join(import.meta.dir, "..", "scripts", "loop-metrics.ts"))}).then(async (m) => console.log(JSON.stringify(await m.durableAutonomy("12"))))`,
    ]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("could not be read");
    const durable = JSON.parse(r.stdout) as DurableAutonomy;
    expect(durable.uncheckedRulings).toBe(1);
    const m = autonomyMetrics([], null, durable);
    expect(m.provisional).toBe(1);
    expect(m.reversedShare).toBeNull();
    expect(renderAutonomyMetrics(m).join("\n")).toContain(
      "share withheld: 1 provisional ruling(s) whose reversal could not be read",
    );
  });

  it("prefers a newer ledger another clone wrote over this clone's state, and this clone's at an equal generation", async () => {
    const forge = fakeForge("");
    forge.write("login", "drive-bot");
    const ledgerAt = (
      generation: number,
      cause: "answered" | "quota-reset",
    ) => {
      const l = renderLedger(
        ledgerFromState(
          {
            ...freshState(12),
            rounds: 3,
            events: [{ at: at(1), round: 1, kind: "rearm", cause }],
          },
          {
            generation,
            driver: {
              actor: "wt-cccccccccccccccc",
              clone: "clone-b",
              heartbeat: at(2),
              state: "stopped",
              exit: 0,
            },
            narrative: [],
            claims: [],
          },
        ),
      );
      if ("error" in l) throw new Error(l.error);
      forge.write("comments-12.json", [
        {
          id: 120,
          body: l.body,
          user: { login: "drive-bot" },
          author_association: "NONE",
          updated_at: at(2),
          created_at: at(2),
          html_url: "https://example.invalid/comment-120",
        },
      ]);
      return l.body;
    };
    const durable = async () => {
      const r = await runIn(forge, "-e", [
        `import(${JSON.stringify(join(import.meta.dir, "..", "scripts", "loop-metrics.ts"))}).then(async (m) => console.log(JSON.stringify(await m.durableAutonomy("12"))))`,
      ]);
      expectSpawnExit(r, 0);
      return JSON.parse(r.stdout) as { events: Array<{ cause: string }> };
    };
    const seed = await runIn(
      forge,
      join(import.meta.dir, "..", "scripts", "drive-state.ts"),
      ["seed-ledger", "12"],
      { stdin: ledgerAt(2, "quota-reset") },
    );
    expectSpawnExit(seed, 0);
    // The forge's ledger differs from this clone's at the same generation.
    ledgerAt(2, "answered");
    expect((await durable()).events.map((e) => e.cause)).toEqual([
      "quota-reset",
    ]);
    ledgerAt(3, "answered");
    expect((await durable()).events.map((e) => e.cause)).toEqual(["answered"]);
  });
});
