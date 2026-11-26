import { describe, expect, it } from "bun:test";
import type {
  LineNeed,
  LineReady,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import {
  answerBand,
  hasNeedRows,
  needRows,
  needCount,
  needPeopleOf,
  needView,
  orderedNeeds,
} from "./needs-view.ts";
import type { Clock } from "./view.ts";

const NOW = Date.UTC(2026, 10, 3, 16, 47, 30);
const CLOCK: Clock = { nowMs: NOW, timeZone: "UTC" };
const iso = (hour: number, minute: number) =>
  new Date(Date.UTC(2026, 10, 3, hour, minute)).toISOString();

function lineOf(id: Parameters<typeof fixture>[0]): LineSnapshot {
  const { line } = fixture(id);
  if (line === null) throw new Error(`the ${id} scenario has no line`);
  return line;
}

const NEED: LineNeed = {
  cause: "needs-person",
  stage: "rearm",
  repo: "example-org/web",
  target: "PR #7",
  pr: 7,
  item: null,
  url: "https://forge.example/example-org/web/pull/7",
  title: "Fix the thing",
  since: iso(10, 0),
  reason: "stopped 14: only a person settles it",
  decisions: [],
  notified: null,
  workspaces: [],
};

const FRAMED = {
  key: "PRRT_x1",
  kind: "thread" as const,
  lines: [
    "## Question",
    "Which one?",
    "",
    "## Recommended",
    "A, it is smaller",
  ],
  question: "Which one?",
  recommendation: "A, it is smaller",
  decisionClass: "scope",
};

const RELEASE = {
  key: "PRRT_r1",
  kind: "thread" as const,
  person: "maintainer-a",
  lines: ["## Question", "Tag v0.159.0 from a bypass account?"],
  question: "Tag v0.159.0 from a bypass account?",
  recommendation: "**Tag it**, because the release commit passed its gates.",
  decisionClass: "release",
  options: [
    {
      name: "Tag it",
      changes: "the release is published.",
      costs: "a person with bypass pushes one tag.",
      recommended: true,
    },
    {
      name: "Wait",
      changes: "nothing.",
      costs: "the release stays unpublished.",
      recommended: false,
    },
  ],
  steps: ["git tag v0.159.0 c618c8d", "git push origin v0.159.0"],
};

describe("what each need asks of a person", () => {
  const release: LineNeed = {
    ...NEED,
    cause: "parked",
    decisions: [RELEASE],
  };

  it("reads a park under release as Authorize, its ask, and the recommended option with what it changes and costs", () => {
    const view = needView(release, CLOCK);
    expect(view.act).toBe("Authorize");
    expect(view.question).toBe("Tag v0.159.0 from a bypass account?");
    expect(view.recommended).toEqual(RELEASE.options[0] ?? null);
    // The option reads in full, so the bare recommendation line is not repeated.
    expect(view.recommendation).toBeNull();
  });

  it("folds the other options and the steps for a person", () => {
    const view = needView(release, CLOCK);
    expect(view.otherOptions.map((o) => o.name)).toEqual(["Wait"]);
    expect(view.steps).toEqual([
      "git tag v0.159.0 c618c8d",
      "git push origin v0.159.0",
    ]);
  });

  it("takes the act the line kept over the one it would derive", () => {
    expect(needView({ ...release, act: "Do" }, CLOCK).act).toBe("Do");
  });

  it("names the person a need waits on, and filtering to one person leaves only theirs", () => {
    const theirs: LineNeed = { ...release, target: "PR #8", pr: 8 };
    const others: LineNeed = {
      ...release,
      target: "PR #9",
      pr: 9,
      // Another release's question, so the two are not one question group.
      decisions: [
        {
          ...RELEASE,
          key: "PRRT_r2",
          person: "maintainer-b",
          question: "Tag v0.160.0 from a bypass account?",
        },
      ],
    };
    const line: LineSnapshot = {
      ...lineOf("quiet"),
      sessions: [],
      needs: [theirs, others, NEED],
    };
    expect(needView(theirs, CLOCK).people).toEqual(["maintainer-a"]);
    expect(needPeopleOf(line)).toEqual(["maintainer-a", "maintainer-b"]);
    const targets = (person: string | null) =>
      needRows(line, CLOCK, person).flatMap((r) =>
        r.type === "need" ? [r.need.target] : [],
      );
    expect(targets(null)).toEqual(["PR #8", "PR #9", "PR #7"]);
    expect(targets("Maintainer-A")).toEqual(["PR #8"]);
  });
});

describe("a park", () => {
  const park: LineNeed = { ...NEED, cause: "parked", decisions: [FRAMED] };

  it("shows the first decision's question and recommendation in place", () => {
    const view = needView(park, CLOCK);
    expect(view.recorded).toBe("parked for a person");
    expect(view.classNote).toBe(", class scope, thread");
    expect(view.question).toBe("Which one?");
    expect(view.recommendation).toBe("Recommended: A, it is smaller");
  });

  it("sends to its pull request on github.com, and a stop with no decision does not", () => {
    const url = "https://github.com/example-org/web/pull/7";
    expect(needView({ ...park, url }, CLOCK).send).toEqual({
      to: { repo: "example-org/web", number: 7 },
    });
    expect("absent" in needView(park, CLOCK).send).toBe(true);
    expect("absent" in needView({ ...NEED, url }, CLOCK).send).toBe(true);
  });

  it("says why a decision's answers were not read, so it does not look unanswered", () => {
    const unread = {
      ...park,
      decisions: [{ ...FRAMED, unread: "the tracker did not open this tick" }],
    };
    expect(needView(unread, CLOCK).answerNotes).toEqual([
      {
        state: "waiting",
        text: "Answers not read, so it still waits: the tracker did not open this tick",
      },
    ]);
    expect(needView(park, CLOCK).answerNotes).toEqual([]);
  });

  it("names each decision key a person answers, once", () => {
    expect(needView(park, CLOCK).answerKeys).toEqual(["PRRT_x1"]);
    const twice = { ...park, decisions: [FRAMED, FRAMED] };
    expect(needView(twice, CLOCK).answerKeys).toEqual(["PRRT_x1"]);
  });

  it("joins each decision's lines for the fold, and Copy decision takes the same text", () => {
    const view = needView(
      {
        ...park,
        decisions: [
          FRAMED,
          { ...FRAMED, key: "PRRT_x2", lines: ["## Question", "And?"] },
        ],
      },
      CLOCK,
    );
    expect(view.foldLabel).toBe("The whole decision");
    expect(view.decision).toBe(
      "## Question\nWhich one?\n\n## Recommended\nA, it is smaller\n\n## Question\nAnd?",
    );
  });

  it("falls back to the reason for a park from before parks were framed", () => {
    const view = needView(
      {
        ...park,
        decisions: [
          {
            ...FRAMED,
            lines: ["One plain sentence."],
            question: null,
            recommendation: null,
            decisionClass: null,
          },
        ],
      },
      CLOCK,
    );
    expect(view.question).toBe(NEED.reason);
    expect(view.recommendation).toBeNull();
    expect(view.classNote).toBe(", thread");
    expect(view.decision).toBe("One plain sentence.");
    // Shown in place, so it is not repeated among the evidence.
    expect(view.evidence.find((row) => row.k === "reason")).toBeUndefined();
  });

  it("keeps the reason in the evidence when a question stands in its place", () => {
    const reason = needView(park, CLOCK).evidence.find((r) => r.k === "reason");
    expect(reason?.v).toBe(NEED.reason);
    expect(reason?.copy).toBe(NEED.reason);
  });

  it("names a finding as a finding", () => {
    const view = needView(
      { ...park, decisions: [{ ...FRAMED, kind: "finding" }] },
      CLOCK,
    );
    expect(view.classNote).toBe(", class scope, finding");
    expect(view.evidence.find((r) => r.k === "finding")?.v).toBe("PRRT_x1");
  });

  it("says Details when the record holds no decision text", () => {
    const view = needView(
      { ...park, decisions: [{ ...FRAMED, lines: [] }] },
      CLOCK,
    );
    expect(view.decision).toBeNull();
    expect(view.foldLabel).toBe("Details");
  });
});

describe("a stage that stopped on a question", () => {
  it("shows a failed follow-up's question in place of its reason, the reason kept in the evidence", () => {
    const question = "Which version does this merge ship in?";
    const view = needView(
      { ...NEED, cause: "followup-failed", question },
      CLOCK,
    );
    expect(view.question).toBe(question);
    expect(view.evidence.find((r) => r.k === "reason")?.v).toBe(NEED.reason);
  });

  it("says which workspace the notice went to", () => {
    const view = needView(
      {
        ...NEED,
        notified: {
          at: iso(10, 5),
          outcome: "sent",
          workspace: "/srv/work/web-notices",
        },
      },
      CLOCK,
    );
    expect(view.evidence.find((r) => r.k === "notified")?.v).toBe(
      "10:05, to /srv/work/web-notices",
    );
  });
});

describe("a need's words", () => {
  it("names a repository's tracker by its product where its issues cannot be reached", () => {
    const words = (tracker?: { adapter: string } | null) =>
      needView(
        { ...NEED, cause: "tracker-unreachable", pr: null, item: "ENG-4" },
        CLOCK,
        tracker,
      ).recorded;
    expect(words({ adapter: "linear" })).toBe("Linear unreachable");
    expect(words({ adapter: "github" })).toBe("GitHub Issues unreachable");
    expect(words(null)).toBe("issues unreachable");
    expect(words()).toBe("issues unreachable");
  });

  it("sends a stuck launch record to its session and the clear command", () => {
    const view = needView({ ...NEED, stuckRecord: "launch-9" }, CLOCK);
    expect(view.evidence).toContainEqual({
      k: "to release",
      v: "a person checks for a session it started, then runs jig dispatch clear",
    });
    expect(view.evidence).toContainEqual({
      k: "clear",
      v: "jig dispatch clear launch-9",
      copy: "jig dispatch clear launch-9",
    });
  });

  it("says there is no link, and offers the key, when no record gives one", () => {
    const view = needView(
      {
        ...NEED,
        cause: "double-claim",
        pr: null,
        target: "WEB-1",
        item: "WEB-1",
        url: null,
      },
      CLOCK,
    );
    expect(view.noLink).toBe(
      "No link was recorded for WEB-1, and the line holds no other link to example-org/web's issues to work it out from: look WEB-1 up there.",
    );
    expect(
      needView(
        {
          ...NEED,
          cause: "double-claim",
          pr: null,
          target: "WEB-1",
          item: "WEB-1",
          url: null,
        },
        CLOCK,
        { adapter: "jira" },
      ).noLink,
    ).toBe(
      "No link was recorded for WEB-1, and the line holds no other Jira link of example-org/web's to work it out from: look WEB-1 up in Jira.",
    );
    expect(view.title).toBe(NEED.title);
    expect(view.keyText).toBe("WEB-1");
    expect(view.answerKeys).toEqual([]);
  });

  it("words an assigner who cannot write", () => {
    expect(
      needView({ ...NEED, cause: "assigner-cannot-write" }, CLOCK).recorded,
    ).toBe("assigner cannot write");
  });

  it("lists how it was notified and the workspaces holding it", () => {
    const evidence = needView(
      {
        ...NEED,
        notified: { at: iso(10, 5), outcome: "sent", workspace: null },
        workspaces: ["/srv/a", "/srv/b"],
      },
      CLOCK,
    ).evidence;
    expect(evidence.find((r) => r.k === "notified")?.v).toBe("10:05");
    expect(evidence.find((r) => r.k === "workspace 2")?.copy).toBe("/srv/b");
  });

  it("says what became of a notification not delivered", () => {
    expect(
      needView(
        {
          ...NEED,
          notified: { at: null, outcome: "lost", workspace: null },
        },
        CLOCK,
      ).evidence.find((r) => r.k === "notified")?.v,
    ).toBe("lost");
  });

  it("says why a notification waits", () => {
    const detail = "the comment is full";
    const notified = (at: string | null) =>
      needView(
        {
          ...NEED,
          notified: { at, outcome: "waits", workspace: null, detail },
        },
        CLOCK,
      ).evidence.find((r) => r.k === "notified")?.v;
    expect(notified(null)).toBe(`waits: ${detail}`);
    expect(notified(iso(10, 5))).toBe(`10:05; now waits: ${detail}`);
  });
});

describe("the person's list", () => {
  it("names repeated no-cause stops as needing a person", () => {
    const view = needView({ ...NEED, cause: "stopped-unknown" }, CLOCK);
    expect(view.recorded).toBe("repeated no-cause stops (needs a person)");
  });

  it("lists the needs by act, in the acts' order, oldest first in each", () => {
    expect(orderedNeeds(lineOf("loud").needs).map((n) => n.target)).toEqual([
      "PR #456",
      "PR #475",
      "PR #95",
      "PR #1210",
      "PR #479",
      "API-77",
      "PR #461",
      "WEB-418",
    ]);
  });

  it("files each cause under its act", () => {
    const heads: Array<[LineNeed["cause"], string]> = [
      ["parked", "Decide"],
      ["needs-person", "Investigate"],
      ["stopped-unknown", "Investigate"],
      ["stalled", "Investigate"],
      ["double-claim", "Investigate"],
      ["followup-failed", "Investigate"],
      ["nudge-unanswered", "Reply"],
      ["assigner-cannot-write", "Do"],
    ];
    for (const [cause, head] of heads) {
      const [first] = needRows(
        { ...lineOf("quiet"), sessions: [], needs: [{ ...NEED, cause }] },
        CLOCK,
      );
      expect(first).toEqual({ type: "head", head });
    }
  });

  it("adds the sessions not moving under their own heading", () => {
    const rows = needRows(lineOf("hung"), CLOCK);
    expect(rows.filter((r) => r.type === "head")).toEqual([
      { type: "head", head: "Reply" },
      { type: "head", head: "Not moving" },
    ]);
    expect(rows.filter((r) => r.type === "stuck").length).toBe(4);
  });
});

describe("whether What needs you exists", () => {
  it("counts stuck records without building their presentation", () => {
    const line = lineOf("quiet");
    const session = line.sessions[0];
    if (session === undefined) throw new Error("fixture needs a session");
    const malformed = {
      ...session,
      launch: "unknown",
      samples: null,
    } as unknown as LineSession;
    expect(needCount({ ...line, needs: [], sessions: [malformed] }, NOW)).toBe(
      1,
    );
    expect(needCount(null, NOW)).toBe(0);
    expect(needCount(lineOf("loud"), NOW)).toBe(
      needRows(lineOf("loud"), CLOCK).filter((r) => r.type !== "head").length,
    );
  });
  it("counts a stuck launch record once, as its need", () => {
    const line = lineOf("quiet");
    const [session] = line.sessions;
    const stuck = {
      ...(session as LineSession),
      launch: "pending",
      stuck: "no workspace",
      record: "launch-9",
    } as LineSession;
    const both: LineSnapshot = {
      ...line,
      needs: [{ ...NEED, stuckRecord: "launch-9" }],
      sessions: [stuck],
    };
    expect(needCount(both, NOW)).toBe(1);
    expect(needRows(both, CLOCK).filter((r) => r.type !== "head").length).toBe(
      1,
    );
    expect(answerBand(both, CLOCK, true, false).sub).not.toContain(
      "not moving",
    );
    expect(needCount({ ...both, needs: [] }, NOW)).toBe(1);
  });
  it("lists a stuck launch record under Investigate", () => {
    const line: LineSnapshot = {
      ...lineOf("quiet"),
      needs: [{ ...NEED, stuckRecord: "launch-9" }],
    };
    expect(
      needRows(line, CLOCK)
        .filter((r) => r.type === "head")
        .map((r) => (r as { head: string }).head),
    ).toEqual(["Investigate"]);
  });
  it("does with a need, or with a session not moving", () => {
    expect(hasNeedRows(lineOf("loud"), NOW)).toBe(true);
    const line = lineOf("quiet");
    const [session] = line.sessions;
    expect(hasNeedRows(line, NOW)).toBe(false);
    expect(
      hasNeedRows(
        {
          ...line,
          sessions: [
            { ...(session as LineSession), drifting: "threads are flat" },
          ],
        },
        NOW,
      ),
    ).toBe(true);
    expect(hasNeedRows(null, NOW)).toBe(false);
  });
});

describe("the answer", () => {
  it("states how many, the oldest, and the first target", () => {
    expect(answerBand(lineOf("loud"), CLOCK, true, false)).toEqual({
      title: "8 need a person.",
      sub: "Oldest 9 h 42 min. 3 sessions working. First: PR #456, parked for a person.",
      loud: true,
    });
  });

  it("counts one, and the sessions not moving", () => {
    expect(answerBand(lineOf("hung"), CLOCK, true, false)).toEqual({
      title: "1 needs a person.",
      sub: "Oldest 12 min. 4 sessions not moving. 1 session working. First: PR #472, nudge-unanswered.",
      loud: true,
    });
  });

  it("is a plain line when nothing needs a person", () => {
    expect(answerBand(lineOf("quiet"), CLOCK, true, false)).toEqual({
      title: "Nothing needs a person.",
      sub: "2 sessions working; 1 account behind a wall; queue empty.",
      loud: false,
    });
  });

  it("says the line is incomplete, rather than that nothing needs a person, when a repository's newest read was refused", () => {
    const line = lineOf("quiet");
    const refusal =
      "the forge cannot say which repository this is: the rate limit holds the call, so nothing was sent";
    const unread: LineSnapshot = {
      ...line,
      repos: line.repos.map((r, i) =>
        i === 0
          ? {
              ...r,
              slug: null,
              ...(r.slug === null ? {} : { lastSlug: r.slug }),
              refused: refusal,
              readAt: iso(15, 0),
            }
          : r,
      ),
    };
    const band = answerBand(unread, CLOCK, true, false);
    expect(band.title).toBe("Nothing needs a person in what was read.");
    expect(band.sub).toContain(
      `1 repository not read: ${line.repos[0]?.slug}, as of 15:00`,
    );
    expect(band.loud).toBe(true);
  });

  it("counts a session not moving when no need is open, so the answer matches the action panel", () => {
    const line = lineOf("quiet");
    const [session] = line.sessions;
    const drifting: LineSnapshot = {
      ...line,
      sessions: [{ ...(session as LineSession), drifting: "threads are flat" }],
    };
    expect(hasNeedRows(drifting, NOW)).toBe(true);
    const band = answerBand(drifting, CLOCK, true, false);
    expect(band.title).toBe("1 session not moving.");
    expect(band.loud).toBe(true);
  });

  it("goes past tense when what is shown is old", () => {
    expect(answerBand(lineOf("stopped"), CLOCK, true, true).title).toBe(
      "Nothing needed a person at the 16:00 tick.",
    );
    expect(answerBand(lineOf("gone"), CLOCK, true, true).title).toBe(
      "8 needed a person at the 16:40 tick.",
    );
  });

  it("says no tick has run before the first", () => {
    expect(answerBand(null, CLOCK, false, false)).toEqual({
      title: "No tick has run on this host.",
      sub: "No receipts, no log rows. The timer writes the first receipt at its first tick.",
      loud: false,
    });
  });

  it("does not claim no log rows when the log holds some", () => {
    expect(answerBand(null, CLOCK, true, false).sub).toBe(
      "The timer writes the first receipt at its first tick.",
    );
  });
});

describe("converged pull requests placed in needs-you by the board read", () => {
  const readyCard = (over: Partial<LineReady> = {}): LineReady => ({
    repo: "example-org/web",
    pr: 501,
    url: "https://forge.example/example-org/web/pull/501",
    title: "Tighten the cache header",
    head: "a".repeat(40),
    place: "needs-you",
    lane: null,
    says: "the forge blocks the merge (BLOCKED) on a rule the board cannot tell, such as signed commits or a deployment: open the pull request",
    act: "open-pr",
    waitingFor: null,
    command: null,
    withheld: null,
    requested: [],
    failing: [],
    failingOmitted: 0,
    conditions: [
      {
        name: "protection lets it merge",
        met: false,
        fact: "merge state BLOCKED",
      },
    ],
    unblocks: [],
    since: iso(15, 0),
    ...over,
  });

  it("surfaces a BLOCKED converged PR in Needs you under Do, counts it, and updates the answer band", () => {
    const blocked = readyCard();
    const line: LineSnapshot = {
      ...lineOf("quiet"),
      needs: [],
      ready: [blocked],
    };
    expect(hasNeedRows(line, NOW)).toBe(true);
    expect(needCount(line, NOW)).toBe(1);
    const rows = needRows(line, CLOCK);
    expect(rows.map((r) => r.type)).toEqual(["head", "ready"]);
    expect(rows[0]).toEqual({ type: "head", head: "Do" });
    expect(rows[1]).toMatchObject({
      type: "ready",
      since: blocked.since,
      ready: {
        act: "Do",
        boardAct: "open the pull request",
        target: "PR #501",
        repo: "example-org/web",
        title: blocked.title,
        says: blocked.says,
        command: "jig ask drive@example-org/web#501",
      },
    });
    const band = answerBand(line, CLOCK, true, false);
    expect(band.loud).toBe(true);
    expect(band.title).toBe("1 needs a person.");
    expect(band.sub).toContain("PR #501");
  });

  it("keeps a matching need and carries the board action and conditions onto it", () => {
    const blocked = readyCard();
    const need = { ...NEED, pr: blocked.pr, target: `PR #${blocked.pr}` };
    const line: LineSnapshot = {
      ...lineOf("quiet"),
      needs: [need],
      ready: [blocked],
    };
    expect(needCount(line, NOW)).toBe(1);
    const row = needRows(line, CLOCK).find((r) => r.type === "need");
    expect(row).toMatchObject({
      type: "need",
      need: { board: { says: blocked.says, conditions: blocked.conditions } },
    });
  });

  it("does not say nothing needs a person when board cards were unread or omitted", () => {
    const quiet = lineOf("quiet");
    const repo = quiet.repos[0];
    if (repo === undefined) throw new Error("Quiet fixture has no repository");
    const line: LineSnapshot = {
      ...quiet,
      repos: [
        {
          ...repo,
          boardUnread: "rate limited",
          readyOmitted: 2,
        },
      ],
    };
    const band = answerBand(line, CLOCK, true, false);
    expect(band.title).toBe("Nothing needs a person in what was read.");
    expect(band.loud).toBe(true);
    expect(band.sub).toContain("board not read in full");
    expect(band.sub).toContain("2 more board cards not shown");
  });

  it("groups each board act under its Needs-you act and orders oldest first beside line.needs", () => {
    const line: LineSnapshot = {
      ...lineOf("quiet"),
      needs: [
        {
          ...NEED,
          cause: "assigner-cannot-write",
          pr: 10,
          target: "PR #10",
          since: iso(14, 0),
        },
      ],
      ready: [
        readyCard({ pr: 501, act: "open-pr", since: iso(13, 0) }),
        readyCard({ pr: 502, act: "answer", since: iso(14, 30) }),
        readyCard({ pr: 503, act: "re-arm", since: iso(15, 0) }),
        readyCard({ pr: 504, act: "re-run-check", since: iso(15, 30) }),
        readyCard({ pr: 505, act: "mark-ready", since: "" }),
        readyCard({ pr: 506, act: null, since: iso(15, 45) }),
      ],
    };
    const rows = needRows(line, CLOCK);
    expect(
      rows.map((r) =>
        r.type === "head"
          ? `HEAD:${r.head}`
          : r.type === "need"
            ? r.need.target
            : r.type === "ready"
              ? r.ready.target
              : r.slot.target,
      ),
    ).toEqual([
      "HEAD:Reply",
      "PR #502",
      "HEAD:Do",
      "PR #501",
      "PR #10",
      "PR #504",
      "PR #505",
      "HEAD:Investigate",
      "PR #503",
      "PR #506",
    ]);
    // Empty since falls back to the tick's finishedAt rather than producing NaN.
    const emptySinceRow = rows.find(
      (r) => r.type === "ready" && r.ready.target === "PR #505",
    );
    expect(
      emptySinceRow?.type === "ready" && emptySinceRow.ready.age,
    ).not.toContain("NaN");
  });

  it("ignores non-needs-you board cards, avoids duplicating a PR already in line.needs, and excludes board cards when filtering to one person", () => {
    const line: LineSnapshot = {
      ...lineOf("quiet"),
      needs: [{ ...NEED, pr: 501, target: "PR #501" }],
      ready: [
        readyCard({ pr: 501, place: "needs-you", lane: null }),
        readyCard({ pr: 502, place: "needs-you", lane: null }),
        readyCard({
          pr: 503,
          place: "ready",
          lane: "merge-now",
          act: "merge",
        }),
        readyCard({ pr: 504, place: "coming", lane: null, act: null }),
        readyCard({ pr: 505, place: "stay", lane: null, act: null }),
      ],
    };
    expect(needCount(line, NOW)).toBe(2);
    expect(
      needRows(line, CLOCK).flatMap((r) =>
        r.type === "ready" ? [r.ready.target] : [],
      ),
    ).toEqual(["PR #502"]);
    expect(needRows(line, CLOCK, "maintainer-a")).toEqual([]);
  });
});
