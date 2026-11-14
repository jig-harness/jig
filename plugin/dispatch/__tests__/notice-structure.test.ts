/**
 * A message about a drive is structured beside its text: the drive's
 * address, the pull request's link, the commands its text names that settle
 * it and, for a park, each framed decision with its options, as the
 * dispatch dashboard shows them. The text is the same as without them.
 */
import { describe, expect, it } from "bun:test";
import { parkNotice, readyNotice, stopNotice } from "../lib/notices.ts";
import type { DrivenPr, WaitingPark } from "../lib/types.ts";

const SLUG = "example-org/example-repo";
const URL = "https://example.test/example-org/example-repo/pull/7";

const TYPED: WaitingPark = {
  key: "F1",
  kind: "finding",
  digest: "d1g3st",
  lines: [],
  decision: {
    schema: "parked-decision/v1",
    class: "design-choice",
    call: {
      id: "c",
      question: "Which retry budget should the client keep?",
      recommended: "a",
      why: "the budget the timeout was sized for",
      options: [
        {
          id: "a",
          name: "Three retries",
          summary: "Keeps the timeout",
          pay: ["Fails sooner"],
        },
        {
          id: "b",
          name: "Five retries",
          summary: "Rides out longer outages",
          pay: ["Outlasts the timeout"],
        },
      ],
    },
    steps: [],
    alreadyDone: "Read the client",
  },
};

function drive(over: Partial<DrivenPr> = {}): DrivenPr {
  return {
    number: 7,
    url: URL,
    title: "Retry the client",
    head: "feature/7",
    class: "parked",
    why: "a decision waits",
    evidence: { generation: 3, exit: 8 },
    waiting: [TYPED],
    ...over,
  } as DrivenPr;
}

describe("a park's message", () => {
  it("carries the drive's address, the pull request's link, and each decision with its options", () => {
    const notice = parkNotice(SLUG, drive());
    expect(notice.address).toBe(`drive@${SLUG}#7`);
    expect(notice.links).toEqual({ pullRequest: URL });
    expect(notice.decisions).toEqual([
      {
        key: "F1",
        digest: "d1g3st",
        question: "Which retry budget should the client keep?",
        recommendation: "Three retries: the budget the timeout was sized for",
        options: [
          {
            name: "Three retries",
            changes: "Keeps the timeout",
            costs: "Fails sooner",
            recommended: true,
          },
          {
            name: "Five retries",
            changes: "Rides out longer outages",
            costs: "Outlasts the timeout",
            recommended: false,
          },
        ],
      },
    ]);
    expect(notice.text).toStartWith(
      `[jig dispatch: ${SLUG} PR #7 parked, ledger generation 3: finding F1]`,
    );
  });

  it("carries a decision from before parks were framed with no options", () => {
    const notice = parkNotice(
      SLUG,
      drive({ waiting: [{ key: "T1", kind: "thread", lines: ["Keep it?"] }] }),
    );
    expect(notice.decisions).toEqual([
      { key: "T1", question: null, recommendation: null, options: [] },
    ]);
  });
});

describe("a ready message", () => {
  const card = {
    number: 7,
    url: URL,
    head: "abc123",
    requested: [],
  };

  it("names `jig ask` for the pinned merge command when it can merge now", () => {
    const notice = readyNotice(SLUG, { ...card, lane: "merge-now" });
    expect(notice).toMatchObject({
      address: `drive@${SLUG}#7`,
      links: { pullRequest: URL },
      acts: [`jig ask drive@${SLUG}#7`],
    });
    expect(notice.text).toContain(`\`jig ask drive@${SLUG}#7\``);
  });

  it("names no act while it waits for an approval", () => {
    const notice = readyNotice(SLUG, { ...card, lane: "approve-first" });
    expect(notice.acts).toBeUndefined();
    expect(notice.address).toBe(`drive@${SLUG}#7`);
  });
});

describe("a stop's message", () => {
  it("names the re-arm commands its text gives", () => {
    const notice = stopNotice(
      SLUG,
      drive({ class: "needs-person" as DrivenPr["class"], waiting: [] }),
    );
    expect(notice.acts).toEqual([
      "/jig:drive-pr 7",
      `jig send drive@${SLUG}#7 rearm`,
    ]);
    for (const act of notice.acts ?? []) expect(notice.text).toContain(act);
  });
});
