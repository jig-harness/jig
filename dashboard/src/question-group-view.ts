/**
 * A question group as Needs you shows it: one card for the needs whose framed
 * decisions are identical apart from their own target
 * (`shared/question-group.ts`). The card asks the question once, with the
 * target replaced by "each item" or "each pull request", and lists every
 * target it covers, each with its repository, link, age and its own
 * evidence: what was already done and the reason, which differ per target.
 *
 * Its rows are the first target's, framed for the group: a pick made on the
 * card is kept under the group's identity (`answers.ts`), so it stays while
 * targets join or leave, and is carried to each target's own decision, with
 * that decision's key and digest, only when it is sent or copied
 * (`question-group-commit.ts`).
 */
import type { LineNeed } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { formatAddress } from "../../plugin/shared/address.ts";
import { uniqueLogins } from "../../plugin/shared/forge-logins.ts";
import { replaceOwnTarget } from "../../plugin/shared/question-group.ts";
import { plural } from "./format.ts";
import type { NeedView } from "./needs-view.ts";
import type { DecisionRow, RowOption } from "./picking.ts";
import type { EvidenceRow } from "./view.ts";

/** One target a group's card covers, with what is its own. */
export interface GroupMember {
  /** The card the target is when it is not in a group. */
  rowKey: string;
  repo: string;
  target: string;
  title: string | null;
  url: string | null;
  noLink: string | null;
  stage: string;
  age: string;
  since: string;
  reason: string;
  /** What its run concluded, from its closing report; `null` without one. */
  concluded: string | null;
  /** What was already done, one entry per decision whose record says. */
  alreadyDone: string[];
  evidence: EvidenceRow[];
  /** Its own decisions, with their own keys and digests: what its answer carries. */
  rows: DecisionRow[];
  send: NeedView["send"];
  acted: NeedView["acted"];
  people: string[];
  /** Its cause in words, as its own card names it. */
  recorded: string;
  /** The address `jig send` answers it at; `null` when the line names none. */
  address: string | null;
}

export interface QuestionGroupView {
  /** The group's identity (`questionGroupId`), the same as `jig ask --waiting` names. */
  id: string;
  /** What the card counts: `item` or `pull request`. */
  noun: "item" | "pull request";
  members: GroupMember[];
}

/** The text under a decision record's `## Already done` heading; `null` when it has none. */
function alreadyDoneIn(lines: string[]): string | null {
  const from = lines.indexOf("## Already done");
  if (from < 0) return null;
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const text = (end < 0 ? rest : rest.slice(0, end)).join(" ").trim();
  return text === "" ? null : text;
}

/** The address `jig send` answers a need at: its station's, else its drive's. */
function addressOf(need: LineNeed): string | null {
  const station = need.decisions.find((d) => d.answer !== undefined)?.answer;
  if (station !== undefined) return station.address;
  return need.pr === null
    ? null
    : formatAddress({
        station: "drive",
        repo: need.repo,
        key: String(need.pr),
      });
}

function memberOf(need: LineNeed, view: NeedView): GroupMember {
  return {
    rowKey: view.rowKey,
    repo: view.repo,
    target: view.target,
    title: view.title,
    url: view.url,
    noLink: view.noLink,
    stage: view.stage,
    age: view.age,
    since: need.since,
    reason: need.reason,
    concluded: view.concluded,
    alreadyDone: need.decisions.flatMap((d) => {
      const text = d.decision?.alreadyDone ?? alreadyDoneIn(d.lines);
      return text === null || text.trim() === "" ? [] : [text];
    }),
    evidence: view.evidence,
    rows: view.rows,
    send: view.send,
    acted: view.acted,
    people: view.people,
    recorded: view.recorded,
    address: addressOf(need),
  };
}

/** A decision row with its text in the group's words and its framing the group's, so a pick on the card is kept for the group. */
function groupRow(
  row: DecisionRow,
  id: string,
  words: (text: string) => string,
): DecisionRow {
  const { digest: _own, ...rest } = row;
  const or = (text: string | null) => (text === null ? null : words(text));
  return {
    ...rest,
    framing: { digest: `${id}/${row.place}`, parkedAt: null },
    question: or(row.question),
    recommendation: or(row.recommendation),
    interplay: row.interplay.map(words),
    options: row.options.map(
      (o): RowOption => ({
        ...o,
        name: words(o.name),
        changes: or(o.changes),
        costs: or(o.costs),
        ...(o.details === undefined
          ? {}
          : {
              details: o.details.map((d) => ({ ...d, text: words(d.text) })),
            }),
      }),
    ),
  };
}

/** The words of an option the card shows, in the group's words. */
function groupOption<
  T extends { name: string; changes: string | null; costs: string | null },
>(option: T, words: (text: string) => string): T {
  return {
    ...option,
    name: words(option.name),
    changes: option.changes === null ? null : words(option.changes),
    costs: option.costs === null ? null : words(option.costs),
  };
}

/**
 * The one card of a question group of two or more needs, oldest first, each
 * with its own view: the first need's card in the group's words, holding
 * every target it covers.
 */
export function groupedNeedView(
  lead: { need: LineNeed; view: NeedView },
  rest: ReadonlyArray<{ need: LineNeed; view: NeedView }>,
  id: string,
): NeedView {
  const members = [lead, ...rest];
  const noun = members.every(({ view }) => /^PR #\d+$/.test(view.target))
    ? "pull request"
    : "item";
  const words = (text: string) =>
    replaceOwnTarget(text, lead.need, `each ${noun}`);
  const { links: _links, ...view } = lead.view;
  return {
    ...view,
    rowKey: `group ${id}`,
    // The cause is not part of the group: where its targets' differ, each names its own.
    recorded: members.every((m) => m.view.recorded === view.recorded)
      ? view.recorded
      : "causes differ; each target names its own",
    recommended:
      view.recommended === null ? null : groupOption(view.recommended, words),
    otherOptions: view.otherOptions.map((o) => groupOption(o, words)),
    steps: view.steps.map(words),
    acted: [],
    answerNotes: [],
    people: uniqueLogins(members.flatMap((m) => m.view.people)),
    target: plural(members.length, noun),
    title: null,
    repo: [...new Set(members.map((m) => m.view.repo))].join(", "),
    question: view.question === null ? null : words(view.question),
    concluded: null,
    recommendation:
      view.recommendation === null ? null : words(view.recommendation),
    decision: null,
    url: null,
    noLink: null,
    rows: view.rows.map((row) => groupRow(row, id, words)),
    send: {
      absent:
        "Send posts one answer to each target listed, on its own pull request or issue.",
    },
    keyText: null,
    foldLabel: "Each target",
    evidence: [],
    group: {
      id,
      noun,
      members: members.map(({ need, view }) => memberOf(need, view)),
    },
  };
}
