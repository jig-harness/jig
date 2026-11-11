/**
 * The answers a person makes on a card, kept in this browser alone so a
 * reload or the next read loses none of them: a pick, a note beside it and an
 * answer in their own words, for each decision. The page never sends one: the
 * card's Copy puts the answer lines on the clipboard, to paste on the pull
 * request.
 *
 * Each decision's answers are kept under its repository, pull request and
 * key, with the framing they were made for (its digest and the time it was
 * parked). A decision framed again, or the same wording parked again, reads
 * with none of them, and says what was dropped (`picking.ts`), so nothing
 * made for one framing reaches another.
 */
import { useCallback, useSyncExternalStore } from "react";
import { keptKeys, readKept, writeKept } from "./kept.ts";
import {
  type CardCommit,
  cardCommit,
  type DecisionRow,
  type KeptAnswer,
  keptAnswerOf,
  rowAnswer,
} from "./picking.ts";

const PREFIX = "answer:";
/** Where reply drafts were kept before a card had rows; read only to forget them. */
const OLD_PREFIX = "reply:";

/** How long answers are kept after their last change. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

// Page-lifetime answers survive unmounting a view, including when storage refuses a write.
const held = new Map<string, { kept: KeptAnswer | null; saved: boolean }>();
const listeners = new Set<() => void>();
let revision = 0;
const snapshot = () => revision;
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

function live(kept: { at: number } | null, nowMs: number): boolean {
  return (
    kept !== null && Number.isFinite(kept.at) && nowMs - kept.at <= KEPT_MS
  );
}

function parsed(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    // Something else wrote this key; it holds no answer.
    if (!(cause instanceof SyntaxError)) throw cause;
    return null;
  }
}

/** The answers kept for one decision, by its repository, target and key. */
export function answerId(repo: string, target: string, key: string): string {
  return `${PREFIX}${repo} ${target} ${key}`;
}

function read(id: string, nowMs: number): KeptAnswer | null {
  const kept = held.has(id)
    ? (held.get(id)?.kept ?? null)
    : keptAnswerOf(parsed(readKept(id)));
  return kept !== null && live(kept, nowMs) ? kept : null;
}

/** Forgets answers not changed for `KEPT_MS`, anything under the prefix that is not one, and old reply drafts. */
export function forgetOldAnswers(nowMs: number): void {
  for (const [id, value] of held) if (!live(value.kept, nowMs)) held.delete(id);
  for (const key of keptKeys(PREFIX))
    if (!live(keptAnswerOf(parsed(readKept(key))), nowMs)) writeKept(key, null);
  for (const key of keptKeys(OLD_PREFIX)) {
    const draft = parsed(readKept(key));
    const at =
      typeof draft === "object" && draft !== null && "at" in draft
        ? Number(draft.at)
        : Number.NaN;
    if (!live({ at }, nowMs)) writeKept(key, null);
  }
  changed();
}

/** The answers kept for each id, read once rather than followed: what a key reads between two draws. */
export function currentAnswers(ids: string[]): (KeptAnswer | null)[] {
  const nowMs = Date.now();
  return ids.map((id) => read(id, nowMs));
}

/** Keeps `kept` under `id`, or forgets it when `null`; whether this browser stored it. */
function keep(id: string, kept: KeptAnswer | null): boolean {
  const saved = writeKept(id, kept === null ? null : JSON.stringify(kept));
  if (!saved) writeKept(id, null);
  held.set(id, { kept, saved });
  changed();
  return saved;
}

/**
 * The answers kept for a card's decisions, followed as they change, how to
 * change one, and whether every one is stored in this browser rather than
 * only held while the page stays open.
 */
export function useAnswers(
  ids: string[],
): [
  (KeptAnswer | null)[],
  (id: string, next: KeptAnswer | null) => void,
  boolean,
] {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const change = useCallback((id: string, next: KeptAnswer | null) => {
    keep(id, next);
  }, []);
  const nowMs = Date.now();
  return [
    ids.map((id) => read(id, nowMs)),
    change,
    ids.every((id) => held.get(id)?.saved !== false),
  ];
}

/** What a need's Copy takes, from the answers kept for its decisions now: what the palette offers to copy. */
export function keptCommit(
  repo: string,
  target: string,
  rows: DecisionRow[],
): CardCommit {
  const kept = currentAnswers(
    rows.map((row) => answerId(repo, target, row.key)),
  );
  return cardCommit(
    rows,
    rows.map((row, i) => rowAnswer(row, kept[i] ?? null)),
  );
}
