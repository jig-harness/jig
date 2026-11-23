/**
 * What a question group's card commits: the answer picked on the card,
 * carried to each target it lists as that target's own answer, with its own
 * decision key and digest, so each station checks it as it checks an answer
 * from the target's own card. A target the person left out gets nothing.
 *
 * Copy takes one `jig send` command per target listed, since the answers go
 * to several pull requests or issues and no one comment answers them all.
 * Send posts each target's answer as its own comment, as the person
 * (`question-group-send.ts`).
 */
import { BROWSER_HOST } from "../../plugin/shared/records/writer-shape.ts";
import { cardAnswerComments } from "../../plugin/shared/decisions/answer-record.ts";
import {
  shellWord,
  stationSendCommand,
} from "../../plugin/shared/decisions/station.ts";
import type { CardAnswer } from "../../plugin/shared/decision-card.ts";
import type { GroupMember, QuestionGroupView } from "./question-group-view.ts";
import {
  type CardCommit,
  cardCommit,
  type DecisionRow,
  type KeptAnswer,
  rowAnswer,
} from "./picking.ts";
import type { SendTarget } from "./send-target.ts";

/** One target's share of the card's answer. */
export interface TargetCommit {
  member: GroupMember;
  commit: CardCommit;
}

export interface GroupCommit extends CardCommit {
  /** The targets listed, each with its own answer. */
  perTarget: TargetCommit[];
}

/** Whether a card's commit is a question group's. */
export function isGroupCommit(commit: CardCommit): commit is GroupCommit {
  return "perTarget" in commit;
}

/**
 * What the card keeps for a group row, as the answer to the same decision
 * of one target: its framing that target's, and the option picked found by
 * its place, since the card shows the options in the group's words. `null`
 * when nothing is kept, or what is kept was made for another framing.
 */
function forTarget(
  kept: KeptAnswer | null,
  group: DecisionRow,
  own: DecisionRow,
): KeptAnswer | null {
  if (kept === null || kept.framing.digest !== group.framing.digest)
    return null;
  const { pick, ...rest } = kept;
  const number = group.options.find((o) => o.name === pick?.option)?.number;
  const option = own.options.find((o) => o.number === number)?.name;
  return {
    ...rest,
    framing: own.framing,
    ...(pick === undefined
      ? {}
      : { pick: { ...pick, option: option ?? pick.option } }),
  };
}

/** The `jig send` command that answers one decision of a target as the card does. */
function sendLine(
  address: string,
  answer: { key: string; digest?: string; answer: CardAnswer },
): string {
  const a = answer.answer;
  if (a.kind === "free")
    return `jig send ${address} answer ${shellWord(answer.key)} ${shellWord(a.text)}`;
  return stationSendCommand(
    { address },
    answer.key,
    a.recommended ? { form: "approve" } : { form: "choose", option: a.option },
    answer.digest,
    a.note,
  );
}

/** What Copy takes for one target: its commands, or, with nothing to send, its answer line under a line naming it. */
function copyLines(t: TargetCommit, whole: CardCommit): string[] {
  const { member, commit } = t;
  const named = `# ${member.repo} ${member.target}`;
  if (member.address === null)
    return [`${named}: no jig send address; answer it where its link goes`];
  if (commit.answers.length > 0)
    return commit.answers.map((a) => sendLine(member.address as string, a));
  const [only] = member.rows;
  const recommended = only?.options.find((o) => o.recommended);
  if (whole.label === "approval" && only !== undefined && recommended)
    return [
      stationSendCommand(
        { address: member.address },
        only.key,
        { form: "approve" },
        only.digest,
      ),
    ];
  return [named, commit.text];
}

/**
 * The card's commit: what is picked on its rows (`rows`, with `kept`, the
 * answers kept for the group), and each listed target's own answer. A fault
 * of one target's answer holds the whole card back, named by that target.
 */
export function groupCommit(
  group: QuestionGroupView,
  rows: DecisionRow[],
  kept: ReadonlyArray<KeptAnswer | null>,
  left: ReadonlySet<string>,
): GroupCommit {
  const whole = cardCommit(
    rows,
    rows.map((row, i) => rowAnswer(row, kept[i] ?? null)),
  );
  const perTarget = group.members
    .filter((m) => !left.has(m.rowKey))
    .map((member) => {
      const answers = member.rows.map((own, i) => {
        const shown = rows[i];
        return rowAnswer(
          own,
          shown === undefined ? null : forTarget(kept[i] ?? null, shown, own),
        );
      });
      return { member, commit: cardCommit(member.rows, answers) };
    });
  const faulted = new Set(whole.faults.map((f) => f.place));
  const faults = [
    ...whole.faults,
    ...perTarget.flatMap(({ member, commit }) =>
      commit.faults
        .filter((f) => !faulted.has(f.place))
        .map((f) => ({ ...f, fault: `${member.target}: ${f.fault}` })),
    ),
  ];
  const [first] = rows;
  if (perTarget.length === 0 && first !== undefined)
    faults.push({
      key: first.key,
      place: first.place,
      fault: "every target is left out, so there is nothing to answer",
    });
  return {
    ...whole,
    answers: [],
    text: perTarget.flatMap((t) => copyLines(t, whole)).join("\n"),
    faults,
    perTarget,
  };
}

/** One target's comments, ready to post as the person. */
export interface TargetSend {
  member: GroupMember;
  to: SendTarget;
  comments: Array<{ key: string; body: string }>;
  /** What the target's own card's Copy would take: what "Sent here" compares. */
  text: string;
  /** The answers the comments carry, one per comment, in order. */
  answers: TargetCommit["commit"]["answers"];
}

/** What posted of a target's send, as "Sent here" keeps it: the whole answer, or only the comments that went, so a reload never reads a partial send as the whole answer. */
export function postedText(s: TargetSend, done: number): string {
  return done === s.comments.length
    ? s.text
    : s.comments
        .slice(0, done)
        .map((c) => c.body)
        .join("\n\n");
}

/**
 * What Send posts for the card, one target after another: each listed
 * target's own comments, as `login` from this browser; and the targets it
 * cannot post for, each with why (no Send there, or nothing picked).
 */
export function groupSends(
  commit: GroupCommit,
  loginFor: (member: GroupMember) => string | null,
  at: string,
): {
  sends: TargetSend[];
  unsendable: Array<{ member: GroupMember; why: string }>;
} {
  const sends: TargetSend[] = [];
  const unsendable: Array<{ member: GroupMember; why: string }> = [];
  for (const { member, commit: own } of commit.perTarget) {
    if (!("to" in member.send)) {
      unsendable.push({ member, why: member.send.absent });
      continue;
    }
    if (own.answers.length === 0) {
      unsendable.push({ member, why: "nothing is picked for it" });
      continue;
    }
    const login = loginFor(member);
    if (login === null) {
      unsendable.push({
        member,
        why: "no kept token answers for its repository owner",
      });
      continue;
    }
    sends.push({
      member,
      to: member.send.to,
      comments: cardAnswerComments(
        own.answers,
        member.send.to.number,
        { login, host: BROWSER_HOST },
        at,
      ),
      text: own.text,
      answers: own.answers,
    });
  }
  return { sends, unsendable };
}
