/**
 * A parked need's picks, notes and own words as one card holds them: what
 * each row's answer is, which decision the keys act on, the card's own keys
 * (sent as `CARD_KEY`), and its Copy (`CARD_COMMIT`, the Copy button and the
 * palette alike), which takes a second step while a guarded pick is among the
 * answers and is held back while a row's answer cannot be sent.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import { answerId, currentAnswers, useAnswers } from "./answers.ts";
import { announce, copyText } from "./copy.tsx";
import { CARD_COMMIT, CARD_KEY, type CardKey, PALETTE_DONE } from "./keys.ts";
import type { NeedView } from "./needs-view.ts";
import {
  type CardCommit,
  cardCommit,
  currentIndex,
  type Held,
  lastPicked,
  nextOpen,
  type RowAnswer,
  type RowOption,
  rowAnswer,
  withoutPick,
  withPick,
  withText,
} from "./picking.ts";

export type Field = "note" | "free";

export interface Picking {
  answers: RowAnswer[];
  commit: CardCommit;
  /** The decision the keys act on, by its place in the rows. */
  current: number;
  /** Whether Copy's first step has shown the guarded picks, so the next Copy copies. */
  confirming: boolean;
  /** Whether this browser stores the answers, rather than holding them only while the page is open. */
  saved: boolean;
  /** The field the person is writing in, opened by `r` or its button. */
  editing: { key: string; field: Field } | null;
  pick: (index: number, option: RowOption) => void;
  clear: (index: number) => void;
  undo: () => void;
  openField: (index: number, field: Field) => void;
  closeField: () => void;
  setText: (index: number, field: Field, text: string) => void;
  /** Asked before each copy: whether it may copy now, else what it said instead. */
  gate: () => boolean;
  /** Ends Copy's first step: a pick changed elsewhere, or the card lost focus. */
  disarm: () => void;
}

/** Where a decision is, as a pick announces it. */
function placeOf(need: NeedView, index: number): string {
  const total = need.rows.length;
  return total > 1 ? `decision ${index + 1} of ${total}` : need.target;
}

/** What makes Copy's first step stand: the decisions' framings and which answer of each counts. */
function signatureOf(need: NeedView, answers: RowAnswer[]): string {
  return need.rows
    .map((row, i) => {
      const a = answers[i];
      return `${row.key} ${row.framing.digest} ${row.framing.parkedAt} ${a?.active} ${a?.pick?.name ?? ""}`;
    })
    .join("\n");
}

export function usePicking(
  need: NeedView,
  card: RefObject<HTMLElement | null>,
): Picking {
  const ids = need.rows.map((row) => answerId(need.repo, need.target, row.key));
  const [kept, change, saved] = useAnswers(ids);
  const answers = need.rows.map((row, i) => rowAnswer(row, kept[i] ?? null));
  const commit = cardCommit(need.rows, answers);
  const [held, setHeld] = useState<Held | null>(null);
  // Keys can come faster than the card draws, so they read the held decision and the kept answers as they are now.
  const heldNow = useRef<Held | null>(null);
  const answersNow = () => {
    const now = currentAnswers(ids);
    return need.rows.map((row, i) => rowAnswer(row, now[i] ?? null));
  };
  const currentNow = () =>
    currentIndex(need.rows, answersNow(), heldNow.current);
  const [editing, setEditing] = useState<Picking["editing"]>(null);
  const [armed, setArmedState] = useState<string | null>(null);
  const armedNow = useRef<string | null>(null);
  const setArmed = (to: string | null) => {
    armedNow.current = to;
    setArmedState(to);
  };
  const current = currentIndex(need.rows, answers, held);
  const signature = signatureOf(need, answers);
  const confirming =
    armed !== null && armed === signature && commit.guarded.length > 0;

  const hold = (index: number) => {
    const row = need.rows[index];
    if (row === undefined) return;
    heldNow.current = { key: row.key, digest: row.framing.digest };
    setHeld(heldNow.current);
  };

  const update = (index: number, next: ReturnType<typeof withoutPick>) => {
    const id = ids[index];
    if (id !== undefined) change(id, next);
  };

  const keptNow = (index: number) => {
    const id = ids[index];
    return id === undefined ? null : (currentAnswers([id])[0] ?? null);
  };

  const pick = (index: number, option: RowOption) => {
    const row = need.rows[index];
    if (row === undefined) return;
    update(index, withPick(row, keptNow(index), option, Date.now()));
    // A pick that changes ends Copy's first step, even when it comes back to the same option.
    setArmed(null);
    hold(nextOpen(answersNow(), index));
    announce(
      `Picked ${option.name} for ${placeOf(need, index)}${option.guarded ? "; copying it takes a second step" : ""}`,
    );
  };

  const clear = (index: number) => {
    const row = need.rows[index];
    const was = answersNow()[index]?.pick;
    if (row === undefined || was == null) return;
    update(index, withoutPick(row, keptNow(index), Date.now()));
    setArmed(null);
    hold(index);
    announce(`Cleared the pick of ${was.name} for ${placeOf(need, index)}`);
  };

  const undo = () => {
    const last = lastPicked(answersNow());
    if (last === null) announce("No pick to undo on this card");
    else clear(last);
  };

  const openField = (index: number, field: Field) => {
    const row = need.rows[index];
    if (row === undefined) return;
    hold(index);
    setEditing({ key: row.key, field });
  };

  const setText = (index: number, field: Field, text: string) => {
    const row = need.rows[index];
    if (row !== undefined)
      update(index, withText(row, keptNow(index), field, text, Date.now()));
  };

  /** The comment to copy now, or `null` when a row holds it back or its first step is still to show. */
  const commitNow = (): string | null => {
    const fresh = answersNow();
    const now = cardCommit(need.rows, fresh);
    const [fault] = now.faults;
    if (fault !== undefined) {
      announce(
        `Not copied: ${placeOf(need, fault.place - 1)} cannot be sent: ${fault.fault}`,
      );
      return null;
    }
    const sign = signatureOf(need, fresh);
    if (now.guarded.length > 0 && armedNow.current !== sign) {
      setArmed(sign);
      announce(
        `Check first: ${now.guarded.map((g) => `${g.option.name} for ${placeOf(need, g.place - 1)}`).join(", ")}. Copy again to copy.`,
      );
      return null;
    }
    setArmed(null);
    return now.text;
  };
  const gate = () => commitNow() !== null;

  const onKey = (key: CardKey) => {
    const current = currentNow();
    if (key.kind === "decision") {
      const to = Math.min(need.rows.length - 1, Math.max(0, current + key.by));
      hold(to);
      announce(`${placeOf(need, to)}: ${need.rows[to]?.question ?? ""}`);
    } else if (key.kind === "undo") undo();
    else if (key.kind === "words")
      openField(current, answersNow()[current]?.pick == null ? "free" : "note");
    else {
      const row = need.rows[current];
      const option = row?.options.find((o) => o.number === key.number);
      if (option === undefined)
        announce(
          row === undefined || row.options.length === 0
            ? "This decision has no options to pick; press r to answer in your own words"
            : `${placeOf(need, current)} has no option ${key.number}`,
        );
      else pick(current, option);
    }
  };

  // The card's listeners read the newest render's handlers.
  const disarm = () => {
    if (armedNow.current !== null) setArmed(null);
  };
  const latest = useRef({ onKey, commitNow, disarm });
  latest.current = { onKey, commitNow, disarm };
  const picks = need.rows.length > 0;
  useEffect(() => {
    const element = card.current;
    if (element === null || !picks) return;
    const onCardKey = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      event.preventDefault();
      latest.current.onKey(event.detail as CardKey);
    };
    const onCommit = (event: Event) => {
      event.preventDefault();
      const text = latest.current.commitNow();
      if (text !== null) void copyText(text, element);
    };
    // The palette ran nothing on this card, or another card's entry: this card's first step ends.
    const onPaletteDone = (event: Event) => {
      if (event instanceof CustomEvent && event.detail !== element.dataset.card)
        latest.current.disarm();
    };
    element.addEventListener(CARD_KEY, onCardKey);
    element.addEventListener(CARD_COMMIT, onCommit);
    document.addEventListener(PALETTE_DONE, onPaletteDone);
    return () => {
      element.removeEventListener(CARD_KEY, onCardKey);
      element.removeEventListener(CARD_COMMIT, onCommit);
      document.removeEventListener(PALETTE_DONE, onPaletteDone);
    };
  }, [card, picks]);

  // A field `r` or its button opened takes focus once it is drawn.
  useEffect(() => {
    if (editing === null) return;
    card.current
      ?.querySelector<HTMLElement>(
        `[data-field="${CSS.escape(`${editing.key} ${editing.field}`)}"]`,
      )
      ?.focus();
  }, [card, editing]);

  return {
    answers,
    commit,
    current,
    confirming,
    saved,
    editing,
    pick,
    clear,
    undo,
    openField,
    closeField: () => setEditing(null),
    setText,
    gate,
    disarm,
  };
}
