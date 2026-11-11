/**
 * Picking an answer on a card, as pure functions of the line and what this
 * browser keeps: one row per decision with its options numbered as
 * `shared/decision-card.ts` numbers them, each row's answer (a pick, a note
 * beside it, or the person's own words, whichever was made last counting),
 * what a decision framed again drops, which decision the keys act on, and the
 * one comment the card's Copy takes.
 *
 * Nothing here writes: a pick is kept in the browser and can be undone, and
 * committing is copying ([structured-answers.md § Picking an answer](../../design/structured-answers.md#picking-an-answer)).
 */
import type {
  LineDecision,
  LineOption,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  actOfClass,
  listedActOfClass,
  type NeedAct,
} from "../../plugin/shared/acts.ts";
import {
  type CardAnswer,
  answerLine,
  cardAnswerText,
  cardComment,
  isGuardedPick,
  numberOptions,
} from "../../plugin/shared/decision-card.ts";
import { answerTextFault } from "../../plugin/shared/decisions/answer-text.ts";
import { isRecord } from "../../plugin/shared/guards.ts";

// ---------- what is kept ----------

/** The framing an answer was made for: its digest and when it was parked, each `null` where the line holds none. */
export interface Framing {
  digest: string | null;
  parkedAt: string | null;
}

/** One kept text or pick, with when it was last changed. */
interface Stamped {
  at: number;
}

/** A decision's answers as this browser keeps them. */
export interface KeptAnswer {
  framing: Framing;
  pick?: Stamped & { option: string };
  note?: Stamped & { text: string };
  free?: Stamped & { text: string };
  /** When anything in it last changed, which its expiry counts from. */
  at: number;
}

function stamped<K extends string>(
  value: unknown,
  field: K,
): (Stamped & Record<K, string>) | undefined {
  if (!isRecord(value)) return undefined;
  const text = value[field];
  const at = value.at;
  return typeof text === "string" && typeof at === "number"
    ? ({ at, [field]: text } as Stamped & Record<K, string>)
    : undefined;
}

function nullOrText(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

/** A kept value read back; `null` when it is not one this page wrote. */
export function keptAnswerOf(value: unknown): KeptAnswer | null {
  if (!isRecord(value) || typeof value.at !== "number") return null;
  const framing = value.framing;
  if (!isRecord(framing)) return null;
  const digest = nullOrText(framing.digest);
  const parkedAt = nullOrText(framing.parkedAt);
  if (digest === undefined || parkedAt === undefined) return null;
  const pick = stamped(value.pick, "option");
  const note = stamped(value.note, "text");
  const free = stamped(value.free, "text");
  return {
    framing: { digest, parkedAt },
    ...(pick === undefined ? {} : { pick }),
    ...(note === undefined ? {} : { note }),
    ...(free === undefined ? {} : { free }),
    at: value.at,
  };
}

function framingOf(d: LineDecision): Framing {
  return { digest: d.digest ?? null, parkedAt: d.parkedAt ?? null };
}

function sameFraming(a: Framing, b: Framing): boolean {
  return a.digest === b.digest && a.parkedAt === b.parkedAt;
}

// ---------- the rows ----------

/** An option as a row shows it: its number, and whether picking it takes two steps to commit. */
export interface RowOption extends LineOption {
  number: number;
  /** `false` when the decision marks it as one that cannot be undone; absent when it says nothing. */
  reversible?: boolean;
  guarded: boolean;
}

/** One decision on a card. */
export interface DecisionRow {
  key: string;
  digest?: string;
  framing: Framing;
  /** Its place on the card, from 1. */
  place: number;
  question: string | null;
  decisionClass: string | null;
  act: NeedAct;
  /** The options in the card's order, the recommended one first as 1. */
  options: RowOption[];
  /** How this decision and another affect each other, as the decisions say. */
  interplay: string[];
  /** The record's recommendation as Markdown, where no option reads as the recommended one; `null` otherwise. */
  recommendation: string | null;
}

/** Whether the decision marks `option` as one that cannot be undone: by its own field, else by the detail the line carries. */
function reversibleOf(
  d: LineDecision,
  option: LineOption,
): boolean | undefined {
  const typed = d.decision?.call.options.find((o) => o.name === option.name);
  if (typed?.reversible !== undefined) return typed.reversible;
  const detail = option.details?.find((x) => x.label === "Reversible");
  return detail === undefined ? undefined : detail.text !== "No";
}

/** The interplay every decision on the card states, each shown beside its own decision and beside any decision it names. */
function interplayOf(decisions: LineDecision[]): Map<string, string[]> {
  const shown = new Map<string, string[]>();
  const add = (key: string, text: string) => {
    const list = shown.get(key) ?? [];
    if (!list.includes(text)) list.push(text);
    shown.set(key, list);
  };
  for (const d of decisions)
    for (const entry of d.decision?.interplay ?? []) {
      const text = `${entry.from} → ${entry.to}: ${entry.text}`;
      add(d.key, text);
      for (const other of decisions)
        if (other.key === entry.from || other.key === entry.to)
          add(other.key, text);
    }
  return shown;
}

/** A card's decisions as rows, oldest first, one per key. */
export function decisionRows(decisions: LineDecision[]): DecisionRow[] {
  const seen = new Set<string>();
  const unique = decisions.filter((d) => {
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
  const interplay = interplayOf(unique);
  return unique.map((d, i) => ({
    key: d.key,
    ...(d.digest === undefined ? {} : { digest: d.digest }),
    framing: framingOf(d),
    place: i + 1,
    question: d.question,
    decisionClass: d.decisionClass,
    act: actOfClass(d.decisionClass),
    options: numberOptions(d.options ?? []).map(({ number, option }) => {
      const reversible = reversibleOf(d, option);
      return {
        ...option,
        number,
        ...(reversible === undefined ? {} : { reversible }),
        guarded: isGuardedPick(
          d.decisionClass,
          reversible === undefined ? {} : { reversible },
        ),
      };
    }),
    interplay: interplay.get(d.key) ?? [],
    recommendation:
      d.recommendation === null || (d.options ?? []).some((o) => o.recommended)
        ? null
        : d.recommendation,
  }));
}

// ---------- a row's answer ----------

/** What a row's answer is now, after its framing is checked. */
export interface RowAnswer {
  pick: RowOption | null;
  /** When the pick was made; `null` with no pick. */
  pickedAt: number | null;
  note: string;
  free: string;
  /** Which of the pick and the person's own words counts: whichever was made last. */
  active: "pick" | "free" | null;
  /** What was dropped because the decision was framed or parked again; `null` when nothing was. */
  dropped: string | null;
  /** Why the counting answer cannot be copied; `null` when it can. */
  fault: string | null;
}

function droppedWords(kept: KeptAnswer): string | null {
  const parts = [
    ...(kept.pick === undefined ? [] : [`your pick of ${kept.pick.option}`]),
    ...((kept.note?.text ?? "").trim() === "" ? [] : ["your note"]),
    ...((kept.free?.text ?? "").trim() === "" ? [] : ["your own words"]),
  ];
  if (parts.length === 0) return null;
  const listed =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Framed again since you answered: ${listed} ${parts.length === 1 ? "was" : "were"} dropped. Read it again and answer.`;
}

const NO_ANSWER: RowAnswer = {
  pick: null,
  pickedAt: null,
  note: "",
  free: "",
  active: null,
  dropped: null,
  fault: null,
};

/** Which answer counts: the pick or the own words, whichever was made last; a tie goes to the pick. */
function activeOf(
  pickedAt: number | null,
  freeAt: number | null,
): RowAnswer["active"] {
  if (pickedAt !== null && (freeAt === null || pickedAt >= freeAt))
    return "pick";
  return freeAt === null ? null : "free";
}

/** When a kept text holds words, when it was last changed; else `null`. */
function wordsAt(
  kept: (Stamped & { text: string }) | undefined,
): number | null {
  return kept === undefined || kept.text.trim() === "" ? null : kept.at;
}

/** The answer `kept` holds for `row`, as the row's framing lets it count. */
export function rowAnswer(
  row: DecisionRow,
  kept: KeptAnswer | null,
): RowAnswer {
  if (kept === null) return NO_ANSWER;
  if (!sameFraming(kept.framing, row.framing))
    return { ...NO_ANSWER, dropped: droppedWords(kept) };
  const option = kept.pick?.option;
  const pick = row.options.find((o) => o.name === option) ?? null;
  const note = kept.note?.text ?? "";
  const free = kept.free?.text ?? "";
  const pickedAt = pick === null ? null : (kept.pick?.at ?? null);
  const active = activeOf(pickedAt, wordsAt(kept.free));
  return {
    pick,
    pickedAt,
    note,
    free,
    active,
    dropped:
      option !== undefined && pick === null
        ? `The option you picked, ${option}, is no longer offered. Pick again.`
        : null,
    fault: faultOf(row, active, pick, note, free),
  };
}

/** The answer the card commits for a row, or `null` when the row has none that counts. */
function counted(answer: RowAnswer): CardAnswer | null {
  if (answer.active === "pick" && answer.pick !== null)
    return {
      kind: "pick",
      option: answer.pick.name,
      recommended: answer.pick.recommended,
      ...(answer.note.trim() === "" ? {} : { note: answer.note }),
    };
  if (answer.active === "free") return { kind: "free", text: answer.free };
  return null;
}

function faultOf(
  row: DecisionRow,
  active: RowAnswer["active"],
  pick: RowOption | null,
  note: string,
  free: string,
): string | null {
  if (active === null) return null;
  const answer: CardAnswer =
    active === "pick" && pick !== null
      ? { kind: "pick", option: pick.name, recommended: pick.recommended }
      : { kind: "free", text: free };
  const line = answerTextFault(cardAnswerText(answer, row.digest));
  if (line !== null) return line;
  if (active === "pick" && note.trim() !== "") {
    const noted = answerTextFault(note.trim());
    if (noted !== null) return `the note: ${noted}`;
  }
  return null;
}

// ---------- changing a row's answer ----------

/** What is kept for `row` to build on: `kept` while it is for this framing, else nothing. */
function base(row: DecisionRow, kept: KeptAnswer | null, nowMs: number) {
  return kept !== null && sameFraming(kept.framing, row.framing)
    ? { ...kept, at: nowMs }
    : { framing: row.framing, at: nowMs };
}

/** `kept` with nothing left in it as `null`, so an empty answer is forgotten. */
function orNull(kept: KeptAnswer): KeptAnswer | null {
  return kept.pick === undefined &&
    kept.note === undefined &&
    kept.free === undefined
    ? null
    : kept;
}

export function withPick(
  row: DecisionRow,
  kept: KeptAnswer | null,
  option: RowOption,
  nowMs: number,
): KeptAnswer {
  return {
    ...base(row, kept, nowMs),
    pick: { option: option.name, at: nowMs },
  };
}

export function withoutPick(
  row: DecisionRow,
  kept: KeptAnswer | null,
  nowMs: number,
): KeptAnswer | null {
  const { pick: _pick, ...rest } = base(row, kept, nowMs);
  return orNull(rest);
}

/** `kept` with a note or the person's own words set to `text`, forgotten when it is blank. */
export function withText(
  row: DecisionRow,
  kept: KeptAnswer | null,
  field: "note" | "free",
  text: string,
  nowMs: number,
): KeptAnswer | null {
  const { [field]: _old, ...rest } = base(row, kept, nowMs);
  return orNull(
    text.trim() === "" ? rest : { ...rest, [field]: { text, at: nowMs } },
  );
}

// ---------- which decision the keys act on ----------

/** The decision the keys act on, held by its key and digest so a reorder or an answered decision does not move it. */
export interface Held {
  key: string;
  digest: string | null;
}

/** The current decision's place: the held one while it is on the card, else the first with no pick. */
export function currentIndex(
  rows: DecisionRow[],
  answers: RowAnswer[],
  held: Held | null,
): number {
  if (held !== null) {
    const at = rows.findIndex(
      (r) => r.key === held.key && r.framing.digest === held.digest,
    );
    if (at !== -1) return at;
  }
  const open = answers.findIndex((a) => a.pick === null);
  return open === -1 ? 0 : open;
}

/** The next decision with no pick after `from`, round the card; `from` when every other has one. */
export function nextOpen(answers: RowAnswer[], from: number): number {
  for (let step = 1; step < answers.length; step++) {
    const at = (from + step) % answers.length;
    if (answers[at]?.pick === null) return at;
  }
  return from;
}

/** The decision whose pick was made last on the card; `null` when none has one. */
export function lastPicked(answers: RowAnswer[]): number | null {
  let last: number | null = null;
  answers.forEach((a, i) => {
    if (a.pickedAt === null) return;
    const lastAt = last === null ? null : (answers[last]?.pickedAt ?? null);
    if (lastAt === null || a.pickedAt >= lastAt) last = i;
  });
  return last;
}

// ---------- what Copy takes ----------

/** A pick whose commit takes two steps. */
export interface GuardedPick {
  key: string;
  place: number;
  option: RowOption;
}

export interface CardCommit {
  /** The one comment Copy takes. */
  text: string;
  /** What it is, as Copy and the palette name it. */
  label: "answers" | "approval" | "answer line";
  /** The picks that make Copy take two steps. */
  guarded: GuardedPick[];
  /** The rows that hold Copy back, each with why. */
  faults: { key: string; place: number; fault: string }[];
  picked: number;
  /** The decisions answered in the person's own words. */
  free: number;
}

/**
 * Whether a card with no answer copies an approval of its recommendation:
 * one decision, a class the acts table lists as Decide, and a recommended
 * option not marked as one that cannot be undone.
 */
function approvable(rows: DecisionRow[]): boolean {
  const [only] = rows;
  if (only === undefined || rows.length !== 1) return false;
  const recommended = only.options.filter((o) => o.recommended);
  return (
    recommended.length === 1 &&
    listedActOfClass(only.decisionClass) === "Decide" &&
    recommended[0]?.reversible !== false
  );
}

/** The comment the card's Copy takes, what holds it back, and what makes it take two steps. */
export function cardCommit(
  rows: DecisionRow[],
  answers: RowAnswer[],
): CardCommit {
  const included = rows.flatMap((row, i) => {
    const answer = answers[i];
    const counts = answer === undefined ? null : counted(answer);
    return counts === null ? [] : [{ row, answer: counts, pick: answer?.pick }];
  });
  const faults = rows.flatMap((row, i) => {
    const fault = answers[i]?.fault ?? null;
    return fault === null ? [] : [{ key: row.key, place: row.place, fault }];
  });
  const picked = included.filter((x) => x.answer.kind === "pick").length;
  const tally = { faults, picked, free: included.length - picked };
  if (included.length > 0)
    return {
      ...tally,
      text: cardComment(
        included.map((x) => ({
          key: x.row.key,
          ...(x.row.digest === undefined ? {} : { digest: x.row.digest }),
          answer: x.answer,
        })),
      ),
      label: "answers",
      guarded: included.flatMap((x) =>
        x.answer.kind === "pick" && x.pick?.guarded === true
          ? [{ key: x.row.key, place: x.row.place, option: x.pick }]
          : [],
      ),
    };
  const [only] = rows;
  const recommended = only?.options.find((o) => o.recommended);
  if (only !== undefined && recommended !== undefined && approvable(rows))
    return {
      ...tally,
      text: cardComment([
        {
          key: only.key,
          ...(only.digest === undefined ? {} : { digest: only.digest }),
          answer: {
            kind: "pick",
            option: recommended.name,
            recommended: true,
          },
        },
      ]),
      label: "approval",
      guarded: [],
    };
  return {
    ...tally,
    text: rows.map((r) => answerLine(r.key, "")).join("\n\n"),
    label: "answer line",
    guarded: [],
  };
}
