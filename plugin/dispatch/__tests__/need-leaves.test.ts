/**
 * What left the line and how (`need-leaves.ts`): a need answered through a
 * station, settled by a rule of the tick, applied from a steward record or
 * whose facts changed each leaves one entry that says so; an answer that did
 * not settle its need shows with its reason while the card stays open, and
 * one answer that settled several needs is one entry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { LineNeed } from "../lib/dashboard-contract.ts";
import {
  answersFrom,
  insertLeaves,
  leaveOf,
  leftNeeds,
  type LeaveEvidence,
  readSettled,
} from "../lib/need-leaves.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { claimAnswer, finishAnswer } from "../lib/station-answer-store.ts";
import { REPO } from "./line-fixtures.ts";

const NOW = "2026-11-23T10:00:00.000Z";
const SINCE = "2026-01-01T00:00:00.000Z";

function need(fields: Partial<LineNeed> = {}): LineNeed {
  return {
    cause: "stalled",
    stage: "pickup",
    repo: REPO,
    target: "ENG-4",
    pr: null,
    item: "ENG-4",
    url: "https://tracker.example/ENG-4",
    title: "Fix the thing",
    since: SINCE,
    reason: "its pickup stalled",
    question: "Release the pickup or leave it?",
    decisions: [
      {
        key: "k",
        kind: "finding",
        lines: [],
        question: null,
        recommendation: null,
        decisionClass: null,
      },
    ],
    notified: null,
    workspaces: [],
    ...fields,
  };
}

const nothing: LeaveEvidence = {
  answers: () => [],
  parks: [],
  actions: [],
  open: new Map(),
};

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jig-need-leaves-"));
});
afterEach(() => {
  closeStateDb(root);
  rmSync(root, { recursive: true, force: true });
});

function answer(
  target: string,
  option: string,
  outcome: "done" | "refused" | "held",
  detail: string,
  at = "a",
): void {
  const row = {
    repo: REPO,
    target,
    key: "k",
    digest: "d",
    answer: `https://forge.example/comment/${at}`,
    author: "maintainer-a",
    option,
  };
  claimAnswer(row, null, root);
  finishAnswer(row, outcome, detail, null, root);
}

describe("which needs left", () => {
  it("names the needs the line before held that the line after does not", () => {
    const a = need();
    const b = need({ target: "ENG-5", item: "ENG-5" });
    expect(leftNeeds([a, b], [b])).toEqual([a]);
  });

  it("counts a need that returns as a new one, and one whose cause changed as left", () => {
    const a = need();
    expect(leftNeeds([a], [need({ cause: "pickup-ended" })])).toEqual([a]);
    expect(leftNeeds([a], [a])).toEqual([]);
  });
});

describe("how a need left", () => {
  it("attributes a need answered through a station to its author, option and outcome, and the settled list shows it", () => {
    answer("ENG-4", "Release the pickup", "done", "moved ENG-4 to todo");
    const db = stateDb(root);
    const left = need();
    const entry = leaveOf(
      left,
      [],
      { ...nothing, answers: answersFrom(db) },
      NOW,
    );
    expect(entry).toMatchObject({
      by: "person",
      who: "maintainer-a",
      option: "Release the pickup",
      outcome: "left",
      at: NOW,
      how: "chose Release the pickup: moved ENG-4 to todo",
      answer: "https://forge.example/comment/a",
    });
    insertLeaves(db, [entry]);
    const settled = readSettled(db, parseMs(NOW), []);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      targets: ["ENG-4"],
      title: "Fix the thing",
      question: "Release the pickup or leave it?",
    });
  });

  it("does not credit an answer to a decision the need did not carry", () => {
    answer("ENG-4", "Release the pickup", "done", "moved ENG-4 to todo");
    const entry = leaveOf(
      need({ decisions: [] }),
      [],
      { ...nothing, answers: answersFrom(stateDb(root)) },
      NOW,
    );
    expect(entry.by).toBe("facts");
  });

  it("attributes a park to the people its receipt names and the option they chose", () => {
    const parked = need({
      cause: "parked",
      target: "PR #7",
      pr: 7,
      item: null,
    });
    const entry = leaveOf(
      parked,
      [],
      {
        ...nothing,
        parks: [
          {
            repo: REPO,
            target: "PR #7",
            key: "k",
            digest: null,
            parkedAt: null,
            outcome: "answered",
            at: "2026-11-23T09:59:00.000Z",
            people: ["maintainer-b"],
            option: "Keep the cache",
            recommended: true,
            words: ["@maintainer-b chose Keep the cache"],
            url: "https://forge.example/pull/7#c1",
          },
        ],
      },
      NOW,
    );
    expect(entry).toMatchObject({
      by: "person",
      who: "maintainer-b",
      option: "Keep the cache",
      recommended: true,
      at: "2026-11-23T09:59:00.000Z",
    });
  });

  it("attributes a need a rule of the tick released to the tick and the rule's reason", () => {
    const entry = leaveOf(
      need(),
      [],
      {
        ...nothing,
        actions: [
          {
            repo: REPO,
            target: "ENG-4",
            stage: "pickup",
            reason:
              "released the stalled pickup so a later tick starts it afresh",
          },
        ],
      },
      NOW,
    );
    expect(entry).toMatchObject({
      by: "tick",
      who: "pickup rule",
      how: "released the stalled pickup so a later tick starts it afresh",
    });
  });

  it("attributes a need applied from a steward record to the steward and the record", () => {
    const entry = leaveOf(
      need(),
      [],
      {
        ...nothing,
        actions: [
          {
            repo: REPO,
            target: "ENG-4",
            stage: "steward",
            reason: "re-armed the drive on the steward's record",
            steward: 12,
          },
        ],
      },
      NOW,
    );
    expect(entry).toMatchObject({
      by: "steward",
      who: "steward record #12",
      how: "re-armed the drive on the steward's record",
    });
  });

  it("says its facts changed when its pull request is no longer open", () => {
    const entry = leaveOf(
      need({ cause: "needs-person", target: "PR #7", pr: 7, item: null }),
      [],
      { ...nothing, open: new Map([[REPO, [3, 4]]]) },
      NOW,
    );
    expect(entry).toMatchObject({ by: "facts", who: null });
    expect(entry.how).toContain("pull request is no longer open");
  });

  it("says when the need became another cause", () => {
    const entry = leaveOf(
      need(),
      [need({ cause: "pickup-ended" })],
      nothing,
      NOW,
    );
    expect(entry).toMatchObject({ by: "facts" });
    expect(entry.how).toContain("pickup-ended");
  });

  it("does not count an answer that was refused as what settled the need", () => {
    answer("ENG-4", "Release the pickup", "refused", "the item is claimed");
    const entry = leaveOf(
      need(),
      [],
      { ...nothing, answers: answersFrom(stateDb(root)) },
      NOW,
    );
    expect(entry.by).toBe("facts");
  });
});

describe("what stays visible", () => {
  it("shows an answer that was refused or held with its reason while its card stays open", () => {
    answer(
      "ENG-4",
      "Release the pickup",
      "refused",
      "the item is claimed",
      "r",
    );
    answer("ENG-5", "Leave it", "held", "a later tick picks it up", "h");
    const open = [
      need(),
      need({ target: "ENG-5", item: "ENG-5", title: "Another" }),
    ];
    const settled = readSettled(stateDb(root), Date.now() + 60_000, open);
    expect(settled.map((s) => [s.targets[0], s.outcome])).toEqual(
      expect.arrayContaining([
        ["ENG-4", "refused"],
        ["ENG-5", "held"],
      ]),
    );
    const refused = settled.find((s) => s.outcome === "refused");
    expect(refused?.how).toContain("the item is claimed");
    expect(refused?.how).toContain("its card stays open");
    expect(refused?.title).toBe("Fix the thing");
  });

  it("does not credit an answer to an earlier framing of the same decision key", () => {
    answer("ENG-4", "Release the pickup", "done", "moved ENG-4 to todo");
    const entry = leaveOf(
      need({
        decisions: [
          {
            key: "k",
            digest: "other",
            kind: "finding",
            lines: [],
            question: null,
            recommendation: null,
            decisionClass: null,
          },
        ],
      }),
      [],
      { ...nothing, answers: answersFrom(stateDb(root)) },
      NOW,
    );
    expect(entry.by).toBe("facts");
  });

  it("lists one answer as one entry although its targets left at different times", () => {
    const shared = {
      by: "person" as const,
      who: "maintainer-a",
      option: "Release the pickup",
      answer: "https://forge.example/comment/x",
      occurrence: "https://forge.example/comment/x 2026-11-23T09:00:00.000Z",
    };
    const db = stateDb(root);
    insertLeaves(
      db,
      [
        leaveOf(need({ target: "ENG-4" }), [], nothing, NOW),
        leaveOf(
          need({ target: "ENG-5" }),
          [],
          nothing,
          isoFromMs(parseMs(NOW) - 60_000),
        ),
      ].map((e) => ({ ...e, ...shared })),
    );
    const settled = readSettled(db, parseMs(NOW), []);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.targets.toSorted()).toEqual(["ENG-4", "ENG-5"]);
  });

  it("keeps an edited answer, another occurrence of the same comment and option, as its own entry", () => {
    const shared = {
      by: "person" as const,
      who: "maintainer-a",
      option: "Release the pickup",
      answer: "https://forge.example/comment/x",
    };
    const db = stateDb(root);
    insertLeaves(
      db,
      [
        {
          ...leaveOf(need({ target: "ENG-4" }), [], nothing, NOW),
          occurrence:
            "https://forge.example/comment/x 2026-11-23T08:00:00.000Z",
        },
        {
          ...leaveOf(need({ target: "ENG-5" }), [], nothing, NOW),
          occurrence:
            "https://forge.example/comment/x 2026-11-23T09:00:00.000Z",
        },
      ].map((e) => ({ ...e, ...shared })),
    );
    expect(readSettled(db, parseMs(NOW), [])).toHaveLength(2);
  });

  it("lists a merged card, one answer that settled several targets, as one entry", () => {
    const shared = {
      by: "person" as const,
      who: "maintainer-a",
      option: "Release the pickup",
      answer: "https://forge.example/comment/x",
      occurrence: "https://forge.example/comment/x 2026-11-23T09:00:00.000Z",
    };
    const db = stateDb(root);
    insertLeaves(
      db,
      [
        leaveOf(need({ target: "ENG-4" }), [], nothing, NOW),
        leaveOf(need({ target: "ENG-5" }), [], nothing, NOW),
      ].map((e) => ({ ...e, ...shared })),
    );
    const settled = readSettled(db, parseMs(NOW), []);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.targets.toSorted()).toEqual(["ENG-4", "ENG-5"]);
  });

  it("keeps the window to a day, newest first, and writes one row per leave so a need that returns is two entries", () => {
    const db = stateDb(root);
    const now = parseMs(NOW);
    const old = isoFromMs(now - 25 * 3_600_000);
    insertLeaves(db, [
      leaveOf(need(), [], nothing, old),
      leaveOf(need(), [], nothing, isoFromMs(now - 3_600_000)),
      leaveOf(need(), [], nothing, isoFromMs(now - 60_000)),
    ]);
    const settled = readSettled(db, now, []);
    expect(settled.map((s) => s.at)).toEqual([
      isoFromMs(now - 60_000),
      isoFromMs(now - 3_600_000),
    ]);
  });

  it("lists an answer as unsettled only while its card is open and no later answer carried it out", () => {
    answer(
      "ENG-4",
      "Release the pickup",
      "refused",
      "the item is claimed",
      "r",
    );
    answer("ENG-5", "Leave it", "held", "a later tick picks it up", "h");
    const db = stateDb(root);
    const now = Date.now() + 60_000;
    // ENG-4's card left the line; ENG-5's stays.
    const only5 = readSettled(db, now, [need({ target: "ENG-5" })]);
    expect(only5.map((s) => s.targets[0])).toEqual(["ENG-5"]);
  });

  it("does not list one answer's mixed outcomes as one entry", () => {
    const db = stateDb(root);
    const shared = { answer: "https://forge.example/comment/x" };
    insertLeaves(db, [
      { ...leaveOf(need({ target: "PR #7" }), [], nothing, NOW), ...shared },
    ]);
    answer("PR #8", "Release the pickup", "refused", "claimed", "x");
    const settled = readSettled(db, parseMs(NOW) + 1, [
      need({ target: "PR #8" }),
    ]);
    expect(settled.map((s) => [s.targets, s.outcome]).sort()).toEqual([
      [["PR #7"], "left"],
      [["PR #8"], "refused"],
    ]);
  });
});

describe("what is not credited", () => {
  it("credits a merged pull request to its facts, not to a follow-up the tick planned for it", () => {
    const entry = leaveOf(
      need({ cause: "needs-person", target: "PR #7", pr: 7, item: null }),
      [],
      {
        ...nothing,
        open: new Map([[REPO, [3]]]),
        actions: [
          {
            repo: REPO,
            target: "PR #7",
            stage: "followup",
            reason: "run the follow-up",
          },
        ],
      },
      NOW,
    );
    expect(entry.by).toBe("facts");
  });

  it("does not credit an answer to another decision of the target", () => {
    answer("ENG-4", "Release the pickup", "done", "moved ENG-4 to todo");
    const entry = leaveOf(
      need({
        decisions: [
          {
            key: "other",
            kind: "thread",
            lines: [],
            question: null,
            recommendation: null,
            decisionClass: null,
          },
        ],
      }),
      [],
      { ...nothing, answers: answersFrom(stateDb(root)) },
      NOW,
    );
    expect(entry.by).toBe("facts");
  });

  it("gives the comment link alone as the answer's link", () => {
    answer("ENG-4", "Release the pickup", "done", "ok");
    const entry = leaveOf(
      need(),
      [],
      { ...nothing, answers: answersFrom(stateDb(root)) },
      NOW,
    );
    expect(entry.answer).toBe("https://forge.example/comment/a");
  });

  it("keeps a group of releases whose target moved on but still lists an earlier item", () => {
    const before = need({
      cause: "release-owed",
      target: "ENG-4",
      covers: ["ENG-4", "ENG-5"],
    });
    const after = need({
      cause: "release-owed",
      target: "ENG-5",
      covers: ["ENG-5"],
    });
    expect(leftNeeds([before], [after])).toEqual([]);
    expect(
      leftNeeds([before], [need({ cause: "release-owed", target: "ENG-9" })]),
    ).toEqual([before]);
  });
});
