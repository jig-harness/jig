/**
 * `jig ask --thread` and `jig ask --waiting`: the thread holds a parked
 * question, the trusted answer to it and a label request with who set it and
 * when it came off, and no answer from an author the forge does not vouch
 * for; it prints the newest entries and says how many it left out, and
 * `--since` and `--all` widen it. `--waiting` lists what the newest tick's
 * line found waiting on a person, as addresses with their acts, with no forge
 * call, says there is no line where none was written, and filters by person.
 * A follow-up's marker places its station.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../../dispatch/lib/dashboard-contract.ts";
import { writeLine } from "../../dispatch/lib/line-store.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  FOLLOWUP_CLAIM,
  manualClaim,
} from "../../shared/records/launch-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import type { WaitingAnswer } from "../lib/waiting.ts";
import {
  type AskWorld,
  askWorld,
  comment,
  pullDoc,
  REPO,
} from "./ask-fixtures.ts";

let current: AskWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function world(): AskWorld {
  current = askWorld();
  current.api("user", { login: "drive-bot" });
  return current;
}

const PARKED_AT = "2026-11-02T09:00:00.000Z";

const parked = (pr: number) =>
  stoppedLedger(pr, 8, {
    driver: {
      actor: "wt-0123456789abcdef",
      clone: "clone-a",
      heartbeat: "2026-11-02T09:00:30.000Z",
      state: "stopped",
      exit: 8,
    },
    parked: [
      {
        key: "PRRT_thread1",
        person: "maintainer",
        kind: "thread",
        reason: "Keep the old flag for one release?",
        class: "scope",
        round: 2,
        at: PARKED_AT,
      },
    ],
  });

async function thread(w: AskWorld, args: string[]) {
  const r = await w.ask([`drive@${REPO}#7`, "--json", ...args]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as AskAnswer;
}

describe("jig ask --thread", () => {
  it("holds the question, the trusted answer and the label request, and no untrusted answer", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(parked(7))),
      comment(
        702,
        "answer PRRT_thread1: keep it for one release",
        "maintainer",
        "MEMBER",
        "2026-11-02T10:00:00Z",
      ),
      comment(
        703,
        "answer PRRT_thread1: drop it now",
        "passer-by",
        "NONE",
        "2026-11-02T10:05:00Z",
      ),
    ]);
    w.api(`repos/${REPO}/issues/7/timeline`, [
      {
        event: "labeled",
        label: { name: "jig:hold" },
        actor: { login: "maintainer" },
        created_at: "2026-11-02T08:00:00Z",
      },
      {
        event: "unlabeled",
        label: { name: "jig:hold" },
        actor: { login: "maintainer" },
        created_at: "2026-11-02T08:30:00Z",
      },
      {
        event: "labeled",
        label: { name: "jig:parked" },
        actor: { login: "drive-bot" },
        created_at: "2026-11-02T09:01:00Z",
      },
    ]);

    const answer = await thread(w, ["--thread"]);
    const entries = answer.thread ?? [];
    expect(entries.map((e) => e.kind)).toEqual([
      "request",
      "question",
      "outcome",
      "answer",
    ]);
    expect(entries[0]).toMatchObject({
      from: "maintainer",
      text: "label jig:hold",
      until: "2026-11-02T08:30:00Z",
    });
    expect(entries[1]).toMatchObject({
      text: "Keep the old flag for one release?",
      record: { kind: "drive-ledger" },
    });
    expect(entries[3]).toMatchObject({
      from: "maintainer",
      text: "answer PRRT_thread1: keep it for one release",
    });
    expect(JSON.stringify(entries)).not.toContain("passer-by");
    expect(answer.threadOmitted).toBe(0);
    // Every parked item answered, and no dispatcher is known to re-arm it: a person re-arms it.
    expect(answer.waitsOn).toMatchObject({ person: "re-arm" });
  });

  it("prints the newest entries, says how many it left out, and widens with --since and --all", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    const answers = Array.from({ length: 25 }, (_, i) =>
      comment(
        800 + i,
        `answer K${i}: yes`,
        "maintainer",
        "MEMBER",
        new Date(Date.parse("2026-11-03T00:00:00Z") + i * 60_000).toISOString(),
      ),
    );
    w.api(`repos/${REPO}/issues/7/comments`, answers);
    w.api(`repos/${REPO}/issues/7/timeline`, []);

    const cut = await thread(w, ["--thread"]);
    expect(cut.thread).toHaveLength(20);
    expect(cut.threadOmitted).toBe(5);
    expect(cut.thread?.[0]?.text).toBe("answer K5: yes");
    const text = await w.ask([`drive@${REPO}#7`, "--thread"]);
    expect(text.stdout).toContain("5 earlier entries left out");

    const all = await thread(w, ["--all"]);
    expect(all.thread).toHaveLength(25);
    expect(all.threadOmitted).toBe(0);

    const since = await thread(w, ["--since", "2026-11-03T00:20:00Z"]);
    expect(since.thread?.map((e) => e.text)).toEqual([
      "answer K20: yes",
      "answer K21: yes",
      "answer K22: yes",
      "answer K23: yes",
      "answer K24: yes",
    ]);
    expect(since.threadOmitted).toBe(20);
  });

  it("prints a record's own words without their control characters", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, "answer K1: yes\u001b[2J and more"),
    ]);
    w.api(`repos/${REPO}/issues/7/timeline`, []);
    const r = await w.ask([`drive@${REPO}#7`, "--thread"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("answer K1: yes [2J and more");
    expect(r.stdout).not.toContain("\u001b");
    const json = await thread(w, ["--thread"]);
    expect(json.thread?.[0]?.text).toBe("answer K1: yes\u001b[2J and more");
  });
});

describe("jig ask on a park", () => {
  it("deduplicates recipients by forge identity while preserving the first spelling", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    const ledger = parked(7);
    const first = ledger.parked[0];
    if (first === undefined) throw new Error("missing parked fixture");
    ledger.parked.push({
      ...first,
      key: "PRRT_thread2",
      person: "Maintainer",
    });
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(ledger)),
    ]);
    const r = await w.ask([`drive@${REPO}#7`, "--json"]);
    expectSpawnExit(r, 0);
    expect((JSON.parse(r.stdout) as AskAnswer).waitsOn).toMatchObject({
      people: ["maintainer"],
    });
    writeLine(
      {
        ...LINE,
        needs: LINE.needs.map((need, i) =>
          i === 0
            ? {
                ...need,
                decisions: need.decisions.map((d, j) => ({
                  ...d,
                  person: j === 0 ? "Maintainer" : "maintainer",
                })),
              }
            : need,
        ),
      },
      "{}",
      w.state,
    );
    const waiting = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(waiting, 0);
    expect(
      (JSON.parse(waiting.stdout) as WaitingAnswer).waiting[0]?.people,
    ).toEqual(["Maintainer"]);
  });

  type LineNeed = (typeof LINE.needs)[number];

  /** Parks thread 7, writes a tick line whose first need is `patch`ed, and returns what `jig ask` says the drive waits on. */
  async function waitsOnWithLineNeed(patch: (need: LineNeed) => LineNeed) {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(parked(7))),
    ]);
    writeLine(
      {
        ...LINE,
        needs: LINE.needs.map((need, i) => (i === 0 ? patch(need) : need)),
      },
      "{}",
      w.state,
    );
    const r = await w.ask([`drive@${REPO}#7`, "--json"]);
    expectSpawnExit(r, 0);
    return (JSON.parse(r.stdout) as AskAnswer).waitsOn;
  }

  it("names the act the newest tick's line names for the park, as the dashboard's card does", async () => {
    // The line counts a reply on a parked thread as its answer, which this read does not: its act stands.
    const waitsOn = await waitsOnWithLineNeed((need) => ({
      ...need,
      act: "Authorize" as const,
    }));
    expect(waitsOn).toMatchObject({ person: "answer", needAct: "Authorize" });
  });

  it("takes the class's act when the line's decision is not one of the open parks", async () => {
    const waitsOn = await waitsOnWithLineNeed((need) => ({
      ...need,
      act: "Authorize" as const,
      decisions: need.decisions.map((d) => ({ ...d, key: "PRRT_obsolete" })),
    }));
    expect(waitsOn).toMatchObject({ person: "answer", needAct: "Decide" });
  });

  it("takes the class's act when the key was re-parked under another class after the line's tick", async () => {
    const waitsOn = await waitsOnWithLineNeed((need) => ({
      ...need,
      act: "Authorize" as const,
      decisions: need.decisions.map((d) => ({
        ...d,
        decisionClass: "release",
      })),
    }));
    expect(waitsOn).toMatchObject({ person: "answer", needAct: "Decide" });
  });

  it("waits on a person's answer while a parked question is unanswered, and lists the commands", async () => {
    const w = world();
    w.api(`repos/${REPO}/pulls/7`, pullDoc(7));
    w.api(`repos/${REPO}/issues/7/comments`, [
      comment(701, ledgerBody(parked(7))),
      comment(
        703,
        "answer PRRT_thread1: drop it now",
        "passer-by",
        "NONE",
        "2026-11-02T10:05:00Z",
      ),
    ]);
    const r = await w.ask([`drive@${REPO}#7`, "--json"]);
    expectSpawnExit(r, 0);
    const answer = JSON.parse(r.stdout) as AskAnswer;
    expect(answer.state).toBe("HITL_PARKED");
    expect(answer.waitsOn).toMatchObject({
      person: "answer",
      people: ["maintainer"],
    });
    const help = await w.ask(["--help"]);
    expectSpawnExit(help, 0);
    expect(help.stdout).toContain("--waiting");
  });
});

describe("jig ask followup", () => {
  it("places a follow-up by its marker", async () => {
    const w = world();
    w.api(
      `repos/${REPO}/pulls/5`,
      pullDoc(5, {
        state: "closed",
        merged: true,
        merged_at: "2026-11-01T00:00:00Z",
      }),
    );
    w.api(`repos/${REPO}/issues/5/comments`, [
      comment(
        501,
        claimBody(
          FOLLOWUP_CLAIM,
          manualClaim(true, {
            pr: 5,
            writer: localWriter("forge", "maintainer"),
          }),
        ),
      ),
    ]);
    const r = await w.ask([`followup@${REPO}#5`, "--json"], w.away);
    expectSpawnExit(r, 0);
    const answer = JSON.parse(r.stdout) as AskAnswer;
    expect(answer.state).toBe("done");
    expect(answer.holder).toBe("none");
    expect(answer.waitsOn).toBe("none");
  });
});

const LINE: LineSnapshot = {
  version: 1,
  runId: "2026-11-05T11-55-00-000Z-1-aaaaaaaa",
  startedAt: "2026-11-05T11:55:00.000Z",
  finishedAt: "2026-11-05T11:56:00.000Z",
  exitStatus: 0,
  apply: true,
  applyWithheld: null,
  intervalMs: 300_000,
  longestTickMs: 60_000,
  plugin: "1.2.3",
  accounts: [],
  lastAccount: null,
  sessions: [],
  needs: [
    {
      cause: "parked",
      stage: "rearm",
      repo: REPO,
      target: "PR #7",
      pr: 7,
      item: null,
      url: `https://github.com/${REPO}/pull/7`,
      title: "Pull request 7",
      since: "2026-11-05T09:00:00.000Z",
      reason: "drive ledger parked: waiting on thread PRRT_thread1",
      decisions: [
        {
          key: "PRRT_thread1",
          kind: "thread",
          question: "Keep the old flag?",
          lines: ["## Question", "Keep the old flag?"],
          recommendation: null,
          decisionClass: "scope",
        },
        {
          key: "PRRT_thread2",
          person: "another-owner",
          kind: "thread",
          question: null,
          lines: ["Which format should remain?"],
          recommendation: null,
          decisionClass: null,
        },
      ],
      notified: null,
      workspaces: [],
    },
    {
      cause: "stalled",
      stage: "pickup",
      repo: REPO,
      target: "#12",
      pr: null,
      item: "#12",
      url: null,
      title: "Issue 12",
      since: "2026-11-05T08:00:00.000Z",
      reason: "claimed, no session for 40 min",
      question: "Which session should continue?\u001b",
      decisions: [],
      notified: null,
      workspaces: [],
    },
  ],
  queue: [],
  repos: [],
};

describe("jig ask --waiting", () => {
  it("lists what the newest tick's line found waiting on a person, with no forge call", async () => {
    const w = world();
    writeLine(LINE, "{}", w.state);
    const r = await w.ask(["--waiting", "--json"], w.away);
    expectSpawnExit(r, 0);
    const answer = JSON.parse(r.stdout) as WaitingAnswer;
    expect(answer.tick).toEqual({
      runId: LINE.runId,
      finishedAt: LINE.finishedAt,
    });
    expect(answer.waiting.map((e) => [e.address, e.act, e.needAct])).toEqual([
      [`drive@${REPO}#7`, "answer", "Decide"],
      [`pickup@${REPO}#12`, "look at the stalled pickup", "Investigate"],
    ]);
    expect(w.calls()).toEqual([]);
    expect(answer.waiting.map((e) => e.questions)).toEqual([
      ["Keep the old flag?", "Which format should remain?"],
      ["Which session should continue?\u001b"],
    ]);
    const text = await w.ask(["--waiting"], w.away);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(`as the tick ${LINE.runId} found it`);
    expect(text.stdout).toContain("look at the stalled pickup · Investigate");
    for (const question of [
      "Keep the old flag?",
      "Which format should remain?",
      "Which session should continue?",
    ])
      expect(text.stdout).toContain(`question: ${question}`);
    expect(text.stdout).not.toContain("\u001b");
  });

  it("filters waiting entries by the named person's login, without forge calls", async () => {
    const w = world();
    writeLine(
      {
        ...LINE,
        needs: LINE.needs.map((n, i) =>
          i === 0
            ? {
                ...n,
                decisions: n.decisions.map((d, j) => ({
                  ...d,
                  person: j === 0 ? "maintainer" : "another-owner",
                })),
              }
            : n,
        ),
      },
      "{}",
      w.state,
    );
    const r = await w.ask(
      ["--waiting", "--person", "MAINTAINER", "--json"],
      w.away,
    );
    expectSpawnExit(r, 0);
    expect(
      (JSON.parse(r.stdout) as WaitingAnswer).waiting.map((e) => e.address),
    ).toEqual([`drive@${REPO}#7`]);
    const other = await w.ask(
      ["--waiting", "--person", "stranger", "--json"],
      w.away,
    );
    expectSpawnExit(other, 0);
    expect((JSON.parse(other.stdout) as WaitingAnswer).waiting).toEqual([]);
    expect(w.calls()).toEqual([]);
  });

  it("says there is no line to read on a machine that dispatches nothing", async () => {
    const w = world();
    const r = await w.ask(["--waiting"], w.away);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("no line to read");
    const person = await w.ask(["--waiting", "--person", "maintainer"], w.away);
    expectSpawnExit(person, 0);
    expect(person.stdout).toContain("no line to read");
  });
});
