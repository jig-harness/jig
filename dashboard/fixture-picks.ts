/**
 * The `picks` scenario's needs: parks framed on the decision model, each
 * with its digest and the time it was parked, as a tick carries them. A card
 * of one decision under a class listed as Decide, a card of two decisions
 * that bear on each other, and a card whose one decision asks for
 * authorization and offers an option that cannot be undone. Their pull
 * requests are on github.com, so each card can Send once a token is kept.
 */
import type {
  LineDecision,
  LineNeed,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../plugin/dispatch/lib/line-decision.ts";
import type { ParkedDecision } from "../plugin/shared/decisions/park.ts";
import { need } from "./fixture-line.ts";
import { API, iso, T, WEB } from "./fixture-rows.ts";

/** A pull request's link on github.com, where Send posts. */
function githubPull(repo: string, pr: number): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

/** The digest of each framing, as the park stored it. */
export const PICK_DIGESTS = {
  one: "3fa9c2d1e0b4",
  flag: "a1b2c3d4e5f6",
  table: "b2c3d4e5f6a1",
  drop: "c3d4e5f6a1b2",
} as const;

function framed(o: {
  cls: string;
  question: string;
  options: {
    id: string;
    name: string;
    changes: string;
    costs: string;
    reversible?: boolean;
  }[];
  recommended: string;
  interplay?: ParkedDecision["interplay"];
}): ParkedDecision {
  return {
    schema: "parked-decision/v1",
    class: o.cls,
    call: {
      id: "a",
      question: o.question,
      recommended: o.recommended,
      why: "it keeps the change small and reversible",
      options: o.options.map(({ changes, costs, ...option }) => ({
        ...option,
        summary: changes,
        pay: [costs],
      })),
    },
    steps: [],
    alreadyDone: "The rest of the pull request is done and its checks pass.",
    ...(o.interplay === undefined ? {} : { interplay: o.interplay }),
  };
}

function parked(
  key: string,
  decision: ParkedDecision,
  digest: string,
  parkedAt: number,
): LineDecision {
  return decisionOf({
    key,
    kind: "thread",
    lines: [],
    decision,
    digest,
    parkedAt: iso(parkedAt),
    person: "maintainer-a",
  });
}

export function picksNeeds(): LineNeed[] {
  const reason =
    "drive ledger parked: stopped 8 (parked), waiting on a person's answer";
  return [
    need({
      cause: "parked",
      stage: "rearm",
      repo: WEB,
      pr: 501,
      url: githubPull(WEB, 501),
      title: "Rename the export flag",
      since: T(8, 0),
      reason,
      decisions: [
        parked(
          "PRRT_one",
          framed({
            cls: "scope",
            question: "Keep the old export flag as an alias?",
            options: [
              {
                id: "r",
                name: "Remove it",
                changes: "the old flag stops working",
                costs: "scripts that still pass it fail",
              },
              {
                id: "k",
                name: "Keep it",
                changes: "the old flag maps to the new one",
                costs: "one more release of the alias",
              },
            ],
            recommended: "k",
          }),
          PICK_DIGESTS.one,
          T(8, 0),
        ),
      ],
      notified: T(8, 5),
    }),
    need({
      cause: "parked",
      stage: "rearm",
      repo: WEB,
      pr: 502,
      url: githubPull(WEB, 502),
      title: "Split the settings page",
      since: T(9, 0),
      reason,
      decisions: [
        parked(
          "PRRT_flag",
          framed({
            cls: "scope",
            question: "Keep the old settings flag for one release?",
            options: [
              {
                id: "k",
                name: "Keep",
                changes: "both pages stay reachable",
                costs: "two pages to keep in step",
              },
              {
                id: "r",
                name: "Remove",
                changes: "only the new page is reachable",
                costs: "bookmarks to the old page break",
              },
            ],
            recommended: "k",
            interplay: [
              {
                from: "PRRT_flag",
                to: "PRRT_table",
                text: "removing the flag leaves the table unused",
              },
            ],
          }),
          PICK_DIGESTS.flag,
          T(9, 0),
        ),
        parked(
          "PRRT_table",
          framed({
            cls: "next-item",
            question: "Move the settings table in this pull request?",
            options: [
              {
                id: "l",
                name: "Later",
                changes: "a follow-up issue moves it",
                costs: "the old table stays a while",
              },
              {
                id: "n",
                name: "Now",
                changes: "this pull request moves it",
                costs: "a larger review",
              },
            ],
            recommended: "l",
          }),
          PICK_DIGESTS.table,
          T(9, 1),
        ),
      ],
      notified: T(9, 5),
    }),
    need({
      cause: "parked",
      stage: "rearm",
      repo: API,
      pr: 1300,
      url: githubPull(API, 1300),
      title: "Retire the legacy invoice table",
      since: T(10, 0),
      reason,
      decisions: [
        parked(
          "PRRT_drop",
          framed({
            cls: "destructive",
            question: "Drop the legacy invoice table now?",
            options: [
              {
                id: "n",
                name: "Do not drop",
                changes: "the table stays until the next release",
                costs: "its storage for one more release",
              },
              {
                id: "d",
                name: "Drop",
                changes: "the table and its rows are deleted",
                costs: "no rollback once deployed",
                reversible: false,
              },
            ],
            recommended: "n",
          }),
          PICK_DIGESTS.drop,
          T(10, 0),
        ),
      ],
      notified: T(10, 5),
    }),
  ];
}
