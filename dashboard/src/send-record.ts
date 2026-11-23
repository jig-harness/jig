/**
 * What this page knows of each target's sends, for the page's life: a send
 * in flight, or one whose comments may have posted with no answer from
 * GitHub ([ADR-0019](../../docs/adr/ADR-0019-the-dashboard-page-answers-as-the-person.md)).
 * It is kept per target (repository and target), whichever card sent, so a
 * target's own card and a question group's card that lists it read and write
 * the same record.
 *
 * An uncertain answer is kept by writer and decision key, since another
 * writer's comment does not supersede it: only a send of one of those same
 * answers to that decision by that writer is held back, until a comment for
 * the decision posts or the person says they checked the linked target.
 */
import { useSyncExternalStore } from "react";
import {
  type CardAnswer,
  cardAnswerLines,
} from "../../plugin/shared/decision-card.ts";

/** A send in flight, or one whose decisions may have posted: `texts` holds every answer of each such decision that may have posted, by writer and key (`uncertainKeyOf`). */
export type SendState =
  | "sending"
  | { uncertain: string; texts: Map<string, string[]> };

/** One decision's answer as Send posts it. */
export interface PostedAnswer {
  key: string;
  digest?: string;
  answer: CardAnswer;
}

/** One decision's whole answer as posted: its answer line and its note line, so a changed condition is a changed answer. */
function answerFingerprint(a: PostedAnswer): string {
  return cardAnswerLines(a.key, a.answer, a.digest).join("\n");
}

/** The key an answer's uncertainty is kept under: the writer too (by the readers' case-insensitive identity). */
function uncertainKeyOf(login: string, key: string): string {
  return `${login.toLowerCase()}\n${key}`;
}

const sends = new Map<string, SendState>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** The record a target's sends are kept under. */
export function sendKeyOf(repo: string, target: string): string {
  return `${repo} ${target}`;
}

export function sendStateOf(key: string): SendState | null {
  return sends.get(key) ?? null;
}

export function useSendState(key: string): SendState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sends.get(key) ?? null,
    () => null,
  );
}

/** Whether `answers` hold one this writer may already have posted to its decision, unchecked. */
export function heldBack(
  state: SendState | null,
  login: string,
  answers: readonly PostedAnswer[],
): boolean {
  if (state === null || state === "sending") return false;
  return answers.some((a) =>
    state.texts
      .get(uncertainKeyOf(login, a.key))
      ?.includes(answerFingerprint(a)),
  );
}

/** Marks a send in flight; what uncertainty the target had before it. */
export function startSend(
  key: string,
): { uncertain: string; texts: Map<string, string[]> } | null {
  const earlier = sends.get(key);
  sends.set(key, "sending");
  changed();
  return earlier !== undefined && earlier !== "sending" ? earlier : null;
}

/** Ends a send with what is still unchecked, or forgets the record: the person checked the linked target. */
export function finishSend(
  key: string,
  uncertain: { reason: string; texts: Map<string, string[]> } | null,
): void {
  if (uncertain === null || uncertain.texts.size === 0) sends.delete(key);
  else sends.set(key, { uncertain: uncertain.reason, texts: uncertain.texts });
  changed();
}

/**
 * Settles a target's send: the answers posted (the first `posted` of
 * `answers`) supersede the earlier uncertainty of their decisions; a decision
 * the send refused or never attempted keeps what it had; and the one that may
 * have posted (`uncertainKey`) adds its answer beside it.
 */
export function settleSend(
  key: string,
  earlier: { uncertain: string; texts: Map<string, string[]> } | null,
  login: string,
  answers: readonly PostedAnswer[],
  posted: number,
  uncertainKey: string | null,
  refused: string | null,
): void {
  const texts = new Map(
    [...(earlier?.texts ?? [])].map(([k, v]) => [k, [...v]]),
  );
  for (const a of answers.slice(0, posted))
    texts.delete(uncertainKeyOf(login, a.key));
  const unsure = answers.find((a) => a.key === uncertainKey);
  if (unsure !== undefined) {
    const mineKey = uncertainKeyOf(login, unsure.key);
    const said = texts.get(mineKey) ?? [];
    const mine = answerFingerprint(unsure);
    texts.set(mineKey, said.includes(mine) ? said : [...said, mine]);
  }
  const reason =
    uncertainKey !== null && refused !== null
      ? refused
      : (earlier?.uncertain ?? "");
  finishSend(key, { reason, texts });
}
