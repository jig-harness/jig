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
 * left out of the next send, so it is never answered twice by accident; the
 * person lists it again once they have checked it.
 *
 * Which targets the person left out is kept here too, for the page's life,
 * so a card drawn again (another view, the next read) keeps the choice.
 */
import { useSyncExternalStore } from "react";
import { announce } from "./copy.tsx";
import { keptToken, tokenGeneration, useKeptToken } from "./forge-token.ts";
import type { NeedView } from "./needs-view.ts";
import { groupSends, isGroupCommit } from "./question-group-commit.ts";
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
  const { kept } = useKeptToken();
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
    const token = keptToken();
    if (token === null) return;
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
    const generation = tokenGeneration();
    update(id, (was) => ({ ...was, sending: true, outcomes: new Map() }));
    announce(`Sending the answers for ${need.target} as ${token.login}`);
    void (async () => {
      const outcomes = new Map<string, TargetOutcome>();
      for (const s of sends) {
        const key = s.member.rowKey;
        const urls: string[] = [];
        const held = () => tokenGeneration() === generation;
        let outcome: TargetOutcome;
        if (!held())
          outcome = {
            kind: "not attempted",
            reason: "the token was forgotten or replaced",
          };
        else
          try {
            const posted = await postAll(
              token.token,
              s.to,
              s.comments,
              urls,
              held,
            );
            outcome =
              posted.refused === null
                ? { kind: "sent", urls: [...urls] }
                : {
                    kind: "refused",
                    reason: posted.refused,
                    uncertain: posted.uncertain || urls.length > 0,
                  };
          } catch {
            // The page lost GitHub mid-send: the comment may have posted.
            outcome = {
              kind: "refused",
              reason:
                "The page lost the connection to GitHub mid-send. Open the target and check before sending again.",
              uncertain: true,
            };
          }
        if (urls.length > 0) {
          watchAnswer(s.member.repo, s.member.target, urls);
          keepSent(s.member.repo, s.member.target, {
            text: s.text,
            urls: [...urls],
            at: Date.now(),
          });
        }
        outcomes.set(key, outcome);
        update(id, (was) => ({ ...was, outcomes: new Map(outcomes) }));
      }
      update(id, (was) => {
        const left = new Set(was.left);
        for (const [key, o] of outcomes) if (o.kind !== "sent") left.add(key);
        return { sending: false, outcomes, left };
      });
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
