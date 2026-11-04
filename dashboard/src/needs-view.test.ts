import { describe, expect, it } from "bun:test";
import type {
  LineNeed,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import {
  answerBand,
  hasNeedRows,
  needRows,
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

describe("a park", () => {
  const park: LineNeed = { ...NEED, cause: "parked", decisions: [FRAMED] };

  it("shows the first decision's question and recommendation in place", () => {
    const view = needView(park, CLOCK);
    expect(view.recorded).toBe("parked for a person");
    expect(view.classNote).toBe(", class scope, thread");
    expect(view.question).toBe("Which one?");
    expect(view.recommendation).toBe("Recommended: A, it is smaller");
    expect(view.goLabel).toBe("Answer on the pull request");
  });

  it("gives the answer line with the option left blank", () => {
    expect(needView(park, CLOCK).answerLine).toBe("answer PRRT_x1: ");
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

describe("a need's words", () => {
  it("labels the link by what the person does", () => {
    const label = (change: Partial<LineNeed>) =>
      needView({ ...NEED, ...change }, CLOCK).goLabel;
    expect(label({ cause: "needs-person" })).toBe(
      "Read the handoff on the pull request",
    );
    expect(label({ cause: "followup-failed" })).toBe("Open the pull request");
    expect(label({ cause: "nudge-unanswered" })).toBe("Open the pull request");
    expect(label({ cause: "stalled", pr: null, item: "ENG-4" })).toBe(
      "Open in the tracker",
    );
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
    expect(view.goLabel).toBeNull();
    expect(view.noLink).toBe(
      "No tracker link: this repository has no tracker base. Look up WEB-1 in the tracker.",
    );
    expect(view.keyText).toBe("WEB-1");
    expect(view.answerLine).toBeNull();
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
    expect(evidence.find((r) => r.k === "notified")?.v).toBe(
      "10:05, to its workspace",
    );
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
});

describe("the person's list", () => {
  it("puts what to decide before what to check, oldest first in each", () => {
    expect(orderedNeeds(lineOf("loud").needs).map((n) => n.target)).toEqual([
      "PR #456",
      "PR #1210",
      "PR #479",
      "PR #475",
      "PR #95",
      "API-77",
      "PR #461",
      "WEB-418",
    ]);
  });

  it("files each cause under its heading", () => {
    const heads: Array<[LineNeed["cause"], string]> = [
      ["parked", "To decide, on the pull request"],
      ["needs-person", "To decide, on the pull request"],
      ["stopped-unknown", "To decide, on the pull request"],
      ["stalled", "To check"],
      ["double-claim", "To check"],
      ["followup-failed", "To check"],
      ["nudge-unanswered", "To check"],
      ["assigner-cannot-write", "To check"],
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
      { type: "head", head: "To check" },
      { type: "head", head: "Not moving" },
    ]);
    expect(rows.filter((r) => r.type === "stuck").length).toBe(4);
  });
});

describe("whether What needs you exists", () => {
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
