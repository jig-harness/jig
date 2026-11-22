/**
 * A question group on Needs you: needs whose decisions are identical apart
 * from their own target are one card listing every target; one answer on it
 * becomes each target's own station answer, posted as the person, one per
 * target listed; a target left out gets nothing and stays open; and a
 * target whose answer the tick refused leaves the group as its own card.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type {
  LineNeed,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../../plugin/dispatch/lib/line-decision.ts";
import { decodeMarker } from "../../plugin/shared/records/envelope.ts";
import { BROWSER_HOST } from "../../plugin/shared/records/writer-shape.ts";
import { frameStationDecision } from "../../plugin/shared/decisions/station.ts";
import { dispatcherDecisionDigest } from "../../plugin/shared/decisions/station-digest.ts";
import { questionGroupId } from "../../plugin/shared/question-group.ts";
import { withoutAnswerRecord } from "../../plugin/shared/decisions/answer-record.ts";
import { fixture } from "../fixtures.ts";
import { allCards } from "./cards.ts";
import { type NeedView, needCount, needRows } from "./needs-view.ts";
import { type KeptAnswer, withPick } from "./picking.ts";
import { groupCommit, groupSends } from "./question-group-commit.ts";
import { postAll } from "./send.tsx";
import type { Clock } from "./view.ts";

const NOW = Date.UTC(2026, 10, 22, 23, 0);
const CLOCK: Clock = { nowMs: NOW, timeZone: "UTC" };
const REPO = "example-org/web";

/** A stalled pickup of issue `n`, framed by the dispatcher, answered on the issue. */
function stalledPickup(n: number, hour: number): LineNeed {
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
    repo: REPO,
    target: item,
    pr: null,
    item,
    url: `https://github.com/${REPO}/issues/${n}`,
    title: `Item ${n}`,
    since: new Date(Date.UTC(2026, 10, 22, hour)).toISOString(),
    reason: `the pickup of ${item} stalled`,
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
          address: `pickup@${REPO}#${n}`,
          on: "issue",
          framedBy: "dispatcher",
        },
      },
    ],
    notified: null,
    workspaces: [],
  };
}

function lineWith(needs: LineNeed[]): LineSnapshot {
  const { line } = fixture("quiet");
  if (line === null) throw new Error("the quiet scenario has no line");
  return { ...line, sessions: [], needs };
}

function cardsOf(line: LineSnapshot): NeedView[] {
  return needRows(line, CLOCK).flatMap((r) =>
    r.type === "need" ? [r.need] : [],
  );
}

function onlyGroup(line: LineSnapshot): NeedView {
  const [card, ...rest] = cardsOf(line);
  if (card?.group === undefined || rest.length > 0)
    throw new Error("expected one question group's card");
  return card;
}

/** The card's recommended option picked, as the card keeps it. */
function pickRecommended(card: NeedView): KeptAnswer[] {
  return card.rows.map((row) => {
    const option = row.options.find((o) => o.recommended);
    if (option === undefined) throw new Error("no recommended option");
    return withPick(row, null, option, NOW);
  });
}

const THREE = [
  stalledPickup(17, 9),
  stalledPickup(27, 10),
  stalledPickup(37, 11),
];

describe("Needs you's question groups", () => {
  it("shows needs that differ only in their target as one card listing each", () => {
    const line = lineWith(THREE);
    const card = onlyGroup(line);
    expect(card.target).toBe("3 items");
    expect(card.question).toBe(
      "How should the stalled pickup of each item go on?",
    );
    expect(card.group?.id ?? null).toBe(questionGroupId(THREE[0] as LineNeed));
    expect(card.group?.members.map((m) => [m.repo, m.target])).toEqual([
      [REPO, "#17"],
      [REPO, "#27"],
      [REPO, "#37"],
    ]);
    // Each target keeps its own evidence: what was already done, and the reason.
    expect(card.group?.members.map((m) => m.reason)).toEqual([
      "the pickup of #17 stalled",
      "the pickup of #27 stalled",
      "the pickup of #37 stalled",
    ]);
    expect(card.group?.members[0]?.alreadyDone[0]).toContain("In Progress");
    // The tab and the answer count needs, one per target, as jig ask --waiting does.
    expect(needCount(line, NOW)).toBe(3);
    const [palette] = allCards(line, CLOCK).filter((c) => c.view === "needs");
    expect(palette?.target).toBe("3 items");
    expect(palette?.committedOnCard).toBe(true);
  });

  it("copies one jig send command per target, each bound to its own digest", () => {
    const card = onlyGroup(lineWith(THREE));
    const group = card.group;
    if (group === undefined) throw new Error("no group");
    const commit = groupCommit(
      group,
      card.rows,
      pickRecommended(card),
      new Set(),
    );
    expect(commit.text.split("\n")).toEqual(
      THREE.map(
        (n) =>
          `jig send pickup@${REPO}#${n.target.slice(1)} answer pickup --approve --decision ${n.decisions[0]?.digest}`,
      ),
    );
  });
});

describe("answering a question group's card", () => {
  afterEach(() => {
    spyOn(globalThis, "fetch").mockRestore();
  });

  /** Posts what Send posts for the card, with GitHub answered here; the paths and bodies it posted. */
  async function send(
    card: NeedView,
    left: ReadonlySet<string>,
  ): Promise<Array<{ path: string; body: string }>> {
    const group = card.group;
    if (group === undefined) throw new Error("no group");
    const posted: Array<{ path: string; body: string }> = [];
    spyOn(globalThis, "fetch").mockImplementation((async (
      url: string,
      init: RequestInit,
    ) => {
      const path = new URL(url).pathname;
      posted.push({ path, body: JSON.parse(String(init.body)).body });
      return Response.json(
        { html_url: `https://github.com${path}#issuecomment-${posted.length}` },
        { status: 201 },
      );
    }) as unknown as typeof fetch);
    const commit = groupCommit(group, card.rows, pickRecommended(card), left);
    const { sends, unsendable } = groupSends(
      commit,
      "maintainer-a",
      "2026-11-22T23:00:00Z",
    );
    expect(unsendable).toEqual([]);
    for (const s of sends) {
      const urls: string[] = [];
      const out = await postAll("t", s.to, s.comments, urls, () => true);
      expect(out.refused).toBeNull();
    }
    return posted;
  }

  /** The decision line and the writer each posted comment carries. */
  function read(body: string) {
    const record = decodeMarker(body, "jig-send-answer", "drive-answer");
    if (!record.ok) throw new Error("no answer record");
    return {
      line: withoutAnswerRecord(body).trim(),
      writer: record.value.envelope.writer,
    };
  }

  it("writes one station answer per target, each as the person, and a refused one stays open as its own card", async () => {
    const card = onlyGroup(lineWith(THREE));
    const posted = await send(card, new Set());
    expect(posted.map((p) => p.path)).toEqual([
      `/repos/${REPO}/issues/17/comments`,
      `/repos/${REPO}/issues/27/comments`,
      `/repos/${REPO}/issues/37/comments`,
    ]);
    expect(posted.map((p) => read(p.body))).toEqual(
      THREE.map((n) => ({
        line: `answer pickup: approve [${n.decisions[0]?.digest}]`,
        writer: { login: "maintainer-a", host: BROWSER_HOST },
      })),
    );

    // The next tick acts on each answer: #17 carried out, #27 still running, #37 refused by its station.
    const acted = (
      n: LineNeed,
      outcome: "done" | "refused" | null,
    ): LineNeed => ({
      ...n,
      decisions: n.decisions.map((d) => ({
        ...d,
        acted: {
          option: "Release the claim",
          author: "maintainer-a",
          outcome,
          detail: outcome === "refused" ? "the item moved since" : null,
        },
      })),
    });
    const [a, b, c] = THREE as [LineNeed, LineNeed, LineNeed];
    const after = cardsOf(
      lineWith([acted(a, "done"), acted(b, null), acted(c, "refused")]),
    );
    expect(after.map((v) => v.target)).toEqual(["2 items", "#37"]);
    expect(
      after[0]?.group?.members.map((m) => [m.target, m.acted[0]?.outcome]),
    ).toEqual([
      ["#17", "done"],
      ["#27", null],
    ]);
    expect(after[1]?.group).toBeUndefined();
    expect(after[1]?.acted[0]).toMatchObject({
      outcome: "refused",
      detail: "the item moved since",
    });
  });

  it("leaving one of three targets out sends two answers, and the third stays open", async () => {
    const card = onlyGroup(lineWith(THREE));
    const third = card.group?.members[2];
    if (third === undefined) throw new Error("no third target");
    const posted = await send(card, new Set([third.rowKey]));
    expect(posted.map((p) => p.path)).toEqual([
      `/repos/${REPO}/issues/17/comments`,
      `/repos/${REPO}/issues/27/comments`,
    ]);
    // The two answered leave the line; the third is a card of its own.
    const after = cardsOf(lineWith([THREE[2] as LineNeed]));
    expect(after.map((v) => [v.target, v.group])).toEqual([["#37", undefined]]);
  });

  it("refuses to send while a listed target has no Send, naming it", () => {
    const [a, b] = THREE as [LineNeed, LineNeed];
    const card = onlyGroup(lineWith([a, { ...b, url: null }]));
    const group = card.group;
    if (group === undefined) throw new Error("no group");
    const commit = groupCommit(
      group,
      card.rows,
      pickRecommended(card),
      new Set(),
    );
    const { sends, unsendable } = groupSends(
      commit,
      "maintainer-a",
      "2026-11-22T23:00:00Z",
    );
    expect(sends.map((s) => s.member.target)).toEqual(["#17"]);
    expect(unsendable.map((u) => u.member.target)).toEqual(["#27"]);
  });
});
