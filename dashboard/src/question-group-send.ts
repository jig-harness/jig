/**
 * Send on a question group's card: one answer per target listed, each the
 * comment that target's own card's Send posts (`send.tsx`), on its own pull
 * request or issue, as the person, one target after another. Each target's
 * station reads and checks its answer on its own, so every guard it applies
 * still runs per target.
 *
 * What each send did is kept for the page's life under the group's
 * identity: sent (with the links), refused (with GitHub's reason), or not
 * attempted. A target whose comment was refused, or may have posted, is
 * left out of the next send; the person lists it again once they have
 * checked it. A comment that may have posted is also kept in the target's
 * own record (`send-record.ts`), the one its own card's Send keeps, so
 * neither card sends that answer again until the person says they checked;
 * what posted is kept as sent here, only that.
 *
 * Which targets the person left out is kept here too, for the page's life,
 * so a card drawn again (another view, the next read) keeps the choice.
 */
import { useSyncExternalStore } from "react";
import { announce } from "./copy.tsx";
import { credentialFor, useKeptTokens } from "./forge-token.ts";
import type { NeedView } from "./needs-view.ts";
import { cardAnswerIds, currentAnswers, forgetAnswers } from "./answers.ts";
import {
  groupSends,
  isGroupCommit,
  postedText,
  type TargetSend,
} from "./question-group-commit.ts";
import type { GroupMember } from "./question-group-view.ts";
import {
  heldBack,
  sendKeyOf,
  sendStateOf,
  finishSend,
  settleSend,
  startSend,
} from "./send-record.ts";
import { postAll } from "./send.tsx";
import { transportFault } from "./send-target.ts";
import { watchAnswer } from "./send-watch.ts";
import { keepSent } from "./sent.ts";
import type { Picking } from "./use-picking.ts";

/** What one send did for one target. */
export type TargetOutcome =
  | { kind: "sent"; urls: string[] }
  | { kind: "refused"; reason: string; uncertain: boolean }
  | { kind: "not attempted"; reason: string };

interface GroupState {
  sending: boolean;
  /** By the target's own card key. */
  outcomes: ReadonlyMap<string, TargetOutcome>;
  left: ReadonlySet<string>;
}

const EMPTY: GroupState = {
  sending: false,
  outcomes: new Map(),
  left: new Set(),
};
const states = new Map<string, GroupState>();
const listeners = new Set<() => void>();

function stateOf(id: string): GroupState {
  return states.get(id) ?? EMPTY;
}

function update(id: string, change: (was: GroupState) => GroupState): void {
  states.set(id, change(stateOf(id)));
  for (const listener of listeners) listener();
}

function useGroupState(id: string): GroupState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => stateOf(id),
    () => EMPTY,
  );
}

/** The targets left out of a group's card, how to list or leave out one, and what the last send did for each target. */
export function useGroupCard(id: string): {
  left: ReadonlySet<string>;
  toggle: (rowKey: string) => void;
  outcomes: ReadonlyMap<string, TargetOutcome>;
} {
  const { left, outcomes } = useGroupState(id);
  return {
    left,
    outcomes,
    toggle: (rowKey) =>
      update(id, (was) => {
        const next = new Set(was.left);
        if (next.has(rowKey)) next.delete(rowKey);
        else next.add(rowKey);
        return { ...was, left: next };
      }),
  };
}

/** A group card's Send; `null` when the card has none (no token kept, or an unsafe page transport). */
export interface GroupSending {
  login: string;
  sending: boolean;
  /** Whether an option is picked, so a press sends. */
  ready: boolean;
  outcomes: ReadonlyMap<string, TargetOutcome>;
  send: () => void;
}

/**
 * The targets a send would post to that this page may already have answered
 * (`send-record.ts`): a send to it is in flight, or an earlier one of the same
 * answer by the same writer had no answer from GitHub and is not checked.
 */
export function uncheckedTargets(
  sends: readonly TargetSend[],
  login: string,
): GroupMember[] {
  return sends.flatMap((s) => {
    const state = sendStateOf(sendKeyOf(s.member.repo, s.member.target));
    return state === "sending" || heldBack(state, login, s.answers)
      ? [s.member]
      : [];
  });
}

/**
 * Posts one target's comments as the person and keeps what happened in the
 * target's own record, as its own card's Send does: the uncertainty of a
 * comment that may have posted, and what posted, only that, as sent here.
 */
export async function sendToTarget(
  token: { token: string; login: string },
  s: TargetSend,
  held: () => boolean,
  /** What the target's record held when the group's send reserved it, when it did. */
  reserved?: ReturnType<typeof startSend> | undefined,
): Promise<TargetOutcome> {
  const record = sendKeyOf(s.member.repo, s.member.target);
  if (!held()) {
    if (reserved !== undefined)
      finishSend(
        record,
        reserved === null
          ? null
          : { reason: reserved.uncertain, texts: reserved.texts },
      );
    return {
      kind: "not attempted",
      reason: "the token was forgotten or replaced",
    };
  }
  const before = reserved !== undefined ? reserved : startSend(record);
  const urls: string[] = [];
  let refused: string | null;
  let uncertainKey: string | null;
  try {
    const posted = await postAll(token.token, s.to, s.comments, urls, held);
    refused = posted.refused;
    uncertainKey = posted.uncertainKey;
  } catch {
    // The page lost GitHub mid-send: the comment it was posting may have posted.
    refused =
      "The page lost the connection to GitHub mid-send. Open the linked target and check before sending again.";
    uncertainKey =
      s.comments[urls.length]?.key ?? s.comments.at(-1)?.key ?? null;
  }
  settleSend(
    record,
    before,
    token.login,
    s.answers,
    urls.length,
    uncertainKey,
    refused,
  );
  if (urls.length > 0) {
    watchAnswer(s.member.repo, s.member.target, urls);
    keepSent(s.member.repo, s.member.target, {
      text: postedText(s, urls.length),
      urls: [...urls],
      at: Date.now(),
    });
  }
  if (refused === null) return { kind: "sent", urls: [...urls] };
  return { kind: "refused", reason: refused, uncertain: uncertainKey !== null };
}

/** What the person is told once a send has gone through every target. */
function summary(
  outcomes: ReadonlyMap<string, TargetOutcome>,
  targets: number,
  login: string,
): string {
  const sent = [...outcomes.values()].filter((o) => o.kind === "sent").length;
  const rest = targets - sent;
  return `Sent the answers for ${sent} of ${targets} as ${login}${rest === 0 ? "" : `; ${rest} not sent, each says why`}`;
}

export function useGroupSend(
  need: NeedView,
  picking: Picking,
): GroupSending | null {
  const { tokens } = useKeptTokens();
  const kept = tokens[0] ?? null;
  const group = need.group;
  const id = group?.id ?? "";
  const state = useGroupState(id);
  if (
    kept === null ||
    group === undefined ||
    transportFault(window.location) !== null
  )
    return null;
  const send = () => {
    if (stateOf(id).sending) return;
    const commit = picking.sendGate();
    if (commit === null || !isGroupCommit(commit)) return;
    const token = kept;
    const { sends, unsendable } = groupSends(
      commit,
      token.login,
      new Date().toISOString(),
    );
    if (unsendable.length > 0) {
      announce(
        `Not sent: ${unsendable.map((u) => `${u.member.repo} ${u.member.target}: ${u.why}`).join("; ")}. Leave those out to send the rest.`,
      );
      return;
    }
    const unchecked = uncheckedTargets(sends, token.login);
    if (unchecked.length > 0) {
      announce(
        `Not sent: ${unchecked.map((m) => `${m.repo} ${m.target}`).join(", ")} may already have its answer from an earlier send. Open it and check, then allow Send again on its row, or leave it out.`,
      );
      return;
    }
    const credentials = group.members
      .map((member) => credentialFor(member.repo))
      .join("\n");
    const held = () =>
      group.members.map((member) => credentialFor(member.repo)).join("\n") ===
      credentials;
    // What the person had picked and written when they pressed Send: a change made while the send runs is newer work.
    const answerIds = cardAnswerIds(need);
    const snapshot = currentAnswers(answerIds).map((a) =>
      a === null ? null : JSON.stringify(a),
    );
    // Every target is reserved now, in this same step as the check above: its own card, or another group's, cannot start a send to it while this one runs.
    const reservations = new Map(
      sends.map((s) => [
        s.member.rowKey,
        startSend(sendKeyOf(s.member.repo, s.member.target)),
      ]),
    );
    update(id, (was) => ({ ...was, sending: true, outcomes: new Map() }));
    announce(`Sending the answers for ${need.target} as ${token.login}`);
    void (async () => {
      const outcomes = new Map<string, TargetOutcome>();
      for (const s of sends) {
        outcomes.set(
          s.member.rowKey,
          await sendToTarget(token, s, held, reservations.get(s.member.rowKey)),
        );
        update(id, (was) => ({ ...was, outcomes: new Map(outcomes) }));
      }
      update(id, (was) => {
        const left = new Set(was.left);
        for (const [key, o] of outcomes) if (o.kind !== "sent") left.add(key);
        return { sending: false, outcomes, left };
      });
      // Every target has its answer: the pick has done its work, unless it changed while sending.
      if ([...outcomes.values()].every((o) => o.kind === "sent")) {
        const now = currentAnswers(answerIds);
        forgetAnswers(
          answerIds.filter(
            (_, i) =>
              (now[i] === null ? null : JSON.stringify(now[i])) === snapshot[i],
          ),
        );
      }
      announce(summary(outcomes, sends.length, token.login));
    })();
  };
  return {
    login: kept.login,
    sending: state.sending,
    ready: picking.commit.picked > 0,
    outcomes: state.outcomes,
    send,
  };
}
