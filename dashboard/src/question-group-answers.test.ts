/**
 * What a question group's card keeps and says of its answers: a pick counts
 * only for the targets and framings it was made for; a send that may have
 * posted is kept in the target's own record, which the group's Send and the
 * target's own card both read; a partial send is kept as only what posted;
 * and a target's row says "Sent here" only for the answer the card would
 * send it now.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { Window } from "happy-dom";
import type {
  LineDecision,
  LineNeed,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../../plugin/dispatch/lib/line-decision.ts";
import { frameStationDecision } from "../../plugin/shared/decisions/station.ts";
import { dispatcherDecisionDigest } from "../../plugin/shared/decisions/station-digest.ts";
import { fixture } from "../fixtures.ts";
import { type NeedView, needRows } from "./needs-view.ts";
import { type KeptAnswer, rowAnswer, withPick, withText } from "./picking.ts";
import {
  groupCommit,
  groupSends,
  postedText,
} from "./question-group-commit.ts";
import {
  leftAfterSend,
  sendToTarget,
  uncheckedTargets,
} from "./question-group-send.ts";
import { targetWords } from "./question-group-words.ts";
import {
  finishSend,
  sendKeyOf,
  sendStateOf,
  settleSend,
} from "./send-record.ts";
import type { Clock } from "./view.ts";

const CLOCK: Clock = { nowMs: Date.UTC(2026, 10, 22, 23), timeZone: "UTC" };
const AT = "2026-11-22T23:00:00Z";

function stalledPickup(repo: string, n: number): LineNeed {
  const item = `#${n}`;
  const framed = frameStationDecision({
    kind: "stalled",
    item,
    state: "In Progress",
    carriedBy: [],
  });
  return {
    cause: "stalled",
    stage: "pickup",
    repo,
    target: item,
    pr: null,
    item,
    url: `https://github.com/${repo}/issues/${n}`,
    title: null,
    since: new Date(Date.UTC(2026, 10, 22, 9, n)).toISOString(),
    reason: "stalled",
    decisions: [
      {
        ...decisionOf({
          key: framed.key,
          kind: "finding",
          decision: framed.decision,
          digest: dispatcherDecisionDigest(framed),
          lines: [],
        }),
        answer: {
          station: "pickup",
          address: `pickup@${repo}#${n}`,
          on: "issue",
          framedBy: "dispatcher",
        },
      },
    ],
    notified: null,
    workspaces: [],
  };
}

function cardOf(needs: LineNeed[]): NeedView {
  const { line } = fixture("quiet");
  if (line === null) throw new Error("no line");
  const [card] = needRows(
    { ...line, sessions: [], needs } as LineSnapshot,
    CLOCK,
  ).flatMap((r) => (r.type === "need" ? [r.need] : []));
  if (card?.group === undefined) throw new Error("expected a group's card");
  return card;
}

function pickRecommended(card: NeedView): KeptAnswer[] {
  return card.rows.map((row) => {
    const option = row.options.find((o) => o.recommended);
    if (option === undefined) throw new Error("no recommended option");
    return withPick(row, null, option, CLOCK.nowMs);
  });
}

function answerGitHub(status: (n: number) => number) {
  let n = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    n++;
    const code = status(n);
    const path = new URL(url).pathname;
    return Response.json(
      code === 201
        ? { html_url: `https://github.com${path}#issuecomment-${n}` }
        : { message: "no" },
      { status: code },
    );
  }) as unknown as typeof fetch);
}

afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore();
});

// What a send keeps goes to the browser's storage, so these checks run with one.
const priorWindow = globalThis.window;
beforeAll(() => {
  Object.assign(globalThis, { window: new Window() });
});
afterAll(() => {
  Object.assign(globalThis, { window: priorWindow });
});

describe("a pick kept on a question group's card", () => {
  it("is dropped, and says so, when a target joins or leaves or one is parked again", () => {
    const repo = "example-org/keep";
    const [a, b, c, d] = [17, 27, 37, 47].map((n) =>
      stalledPickup(repo, n),
    ) as [LineNeed, LineNeed, LineNeed, LineNeed];
    const before = cardOf([a, b, c]);
    const kept = pickRecommended(before);
    const group = before.group;
    if (group === undefined) throw new Error("no group");
    expect(groupCommit(group, before.rows, kept, new Set()).picked).toBe(1);

    const reparked = (n: LineNeed): LineNeed => ({
      ...n,
      decisions: n.decisions.map(
        (x): LineDecision => ({
          ...x,
          parkedAt: "2026-11-23T01:00:00Z",
        }),
      ),
    });
    for (const after of [
      cardOf([a, b, d]),
      cardOf([a, b]),
      cardOf([a, reparked(b), c]),
    ]) {
      expect(after.group?.id).toBe(group.id);
      const row = after.rows[0];
      if (row === undefined || after.group === undefined)
        throw new Error("no row");
      expect(rowAnswer(row, kept[0] ?? null).dropped).toContain("dropped");
      const commit = groupCommit(after.group, after.rows, kept, new Set());
      expect(commit.picked).toBe(0);
      expect(commit.perTarget.every((t) => t.commit.answers.length === 0)).toBe(
        true,
      );
    }
  });
});

describe("a group card's Copy", () => {
  it("holds back own words that jig send cannot submit", () => {
    const card = cardOf([
      stalledPickup("example-org/words", 17),
      stalledPickup("example-org/words", 27),
    ]);
    const group = card.group;
    const row = card.rows[0];
    if (group === undefined || row === undefined)
      throw new Error("no group row");
    const commit = groupCommit(
      group,
      card.rows,
      [withText(row, null, "free", "please investigate", CLOCK.nowMs)],
      new Set(),
    );
    expect(commit.faults[0]?.fault).toContain("cannot be copied");
  });
});

describe("a send with no answer from GitHub, on a question group's card", () => {
  it("is kept in the target's own record, held back on the next send until checked", async () => {
    const repo = "example-org/unsure";
    const card = cardOf([stalledPickup(repo, 17), stalledPickup(repo, 27)]);
    const group = card.group;
    if (group === undefined) throw new Error("no group");
    const { sends } = groupSends(
      groupCommit(group, card.rows, pickRecommended(card), new Set()),
      () => "maintainer-a",
      AT,
    );
    // GitHub answers #17 and gives no answer for #27.
    answerGitHub((n) => (n === 1 ? 201 : 502));
    const token = { token: "t", login: "maintainer-a" };
    const outcomes = [];
    for (const s of sends)
      outcomes.push(await sendToTarget(token, s, () => true));
    expect(outcomes.map((o) => o.kind)).toEqual(["sent", "refused"]);
    expect(outcomes[1]).toMatchObject({ uncertain: true });

    // The record is the one #27's own card reads, by its repository and target.
    const record = sendKeyOf(repo, "#27");
    expect(sendStateOf(record)).toMatchObject({
      uncertain: expect.any(String),
    });
    expect(sendStateOf(sendKeyOf(repo, "#17"))).toBeNull();
    expect(
      uncheckedTargets(sends, "maintainer-a").map((m) => m.target),
    ).toEqual(["#27"]);
    // Another writer's answer is not the one that may have posted.
    expect(uncheckedTargets(sends, "maintainer-b")).toEqual([]);
    finishSend(record, null);
    expect(uncheckedTargets(sends, "maintainer-a")).toEqual([]);
  });

  it("holds back a target whose own card's earlier send may have posted the same answer", () => {
    const repo = "example-org/earlier";
    const card = cardOf([stalledPickup(repo, 17), stalledPickup(repo, 27)]);
    const group = card.group;
    if (group === undefined) throw new Error("no group");
    const { sends } = groupSends(
      groupCommit(group, card.rows, pickRecommended(card), new Set()),
      () => "maintainer-a",
      AT,
    );
    const own = sends[0];
    if (own === undefined) throw new Error("no send");
    // What #17's own card's Send records when GitHub gave it no answer.
    settleSend(
      sendKeyOf(repo, "#17"),
      null,
      "maintainer-a",
      own.answers,
      0,
      own.answers[0]?.key ?? null,
      "GitHub gave no answer",
    );
    expect(
      uncheckedTargets(sends, "maintainer-a").map((m) => m.target),
    ).toEqual(["#17"]);
    finishSend(sendKeyOf(repo, "#17"), null);
  });
});

/** A park on pull request `pr` with two decisions, each with a recommended option. */
function twoDecisionPark(repo: string, pr: number): LineNeed {
  const decision = (key: string, question: string): LineDecision => ({
    key: `${key}${pr}`,
    kind: "finding",
    digest: `d-${key}${pr}`,
    lines: [],
    question,
    recommendation: "Keep: it is smaller",
    decisionClass: "scope",
    options: [
      {
        name: "Keep",
        changes: "nothing",
        costs: "a follow-up",
        recommended: true,
      },
      {
        name: "Widen",
        changes: "the scope",
        costs: "a review",
        recommended: false,
      },
    ],
    steps: [],
  });
  return {
    cause: "parked",
    stage: "rearm",
    repo,
    target: `PR #${pr}`,
    pr,
    item: null,
    url: `https://github.com/${repo}/pull/${pr}`,
    title: null,
    since: new Date(Date.UTC(2026, 10, 22, 9, pr)).toISOString(),
    reason: "parked",
    decisions: [decision("a", "Keep the flag?"), decision("b", "Rename it?")],
    notified: null,
    workspaces: [],
  };
}

describe("a partial send of a target with several decisions", () => {
  it("is kept as only what posted, and its row then reads as an earlier answer", async () => {
    const repo = "example-org/partial";
    const card = cardOf([twoDecisionPark(repo, 7), twoDecisionPark(repo, 8)]);
    const group = card.group;
    if (group === undefined) throw new Error("no group");
    const { sends } = groupSends(
      groupCommit(group, card.rows, pickRecommended(card), new Set()),
      () => "maintainer-a",
      AT,
    );
    const s = sends[0];
    if (s === undefined) throw new Error("no send");
    expect(s.comments).toHaveLength(2);
    // GitHub takes the first comment and refuses the second.
    answerGitHub((n) => (n === 1 ? 201 : 422));
    const outcome = await sendToTarget(
      { token: "t", login: "maintainer-a" },
      s,
      () => true,
    );
    expect(outcome.kind).toBe("refused");
    const kept = postedText(s, 1);
    expect(kept).toBe(s.comments[0]?.body ?? "");
    expect(kept).not.toBe(s.text);
    expect(postedText(s, 2)).toBe(s.text);
    expect(targetWords(s.member, undefined, { text: kept }, s.text)?.text).toBe(
      "An earlier answer was sent here; the next tick reads it.",
    );
  });
});

describe("a group send retry", () => {
  it("leaves both sent and refused targets out until a person lists one again", () => {
    const left = leftAfterSend(
      new Set(["already-left"]),
      new Map([
        ["sent", { kind: "sent", urls: [] }],
        ["refused", { kind: "refused", reason: "no", uncertain: false }],
        ["not-attempted", { kind: "not attempted", reason: "no token" }],
      ]),
    );
    expect([...left]).toEqual([
      "already-left",
      "sent",
      "refused",
      "not-attempted",
    ]);
  });
});

describe("a target's row", () => {
  it("says Sent here only for the answer the card would send it now", () => {
    const card = cardOf([
      stalledPickup("example-org/rows", 17),
      stalledPickup("example-org/rows", 27),
    ]);
    const member = card.group?.members[0];
    if (member === undefined) throw new Error("no member");
    const sent = { text: "answer pickup: approve [d]" };
    expect(targetWords(member, undefined, sent, sent.text)?.text).toBe(
      "Sent here; the next tick reads it.",
    );
    expect(
      targetWords(member, undefined, sent, "answer pickup: choose Hold [d]")
        ?.text,
    ).toBe("An earlier answer was sent here; the next tick reads it.");
    expect(targetWords(member, undefined, sent, undefined)?.text).toBe(
      "An earlier answer was sent here; the next tick reads it.",
    );
    expect(targetWords(member, undefined, null, sent.text)).toBeNull();
  });
});
