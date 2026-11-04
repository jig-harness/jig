/**
 * The replies a person drafts beside a decision, kept in this browser alone so
 * a reload or the next read loses none of them. The page never sends one: Copy
 * puts the answer lines on the clipboard, to paste on the pull request.
 */
import { useCallback, useSyncExternalStore } from "react";
import { keptKeys, readKept, writeKept } from "./kept.ts";

const PREFIX = "reply:";

/** How long a draft is kept after its last edit. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

interface Draft {
  text: string;
  at: number;
}

// Page-lifetime drafts survive unmounting Now, including when storage refuses a write.
const drafts = new Map<string, { draft: Draft; saved: boolean }>();
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

function live(draft: Draft | null, nowMs: number): draft is Draft {
  return (
    draft !== null && Number.isFinite(draft.at) && nowMs - draft.at <= KEPT_MS
  );
}

function draftOf(raw: string | null): Draft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "text" in value &&
      "at" in value &&
      typeof value.text === "string" &&
      typeof value.at === "number"
    )
      return { text: value.text, at: value.at };
    return null;
  } catch (cause) {
    // Something else wrote this key; it is not a draft.
    if (!(cause instanceof SyntaxError)) throw cause;
    return null;
  }
}

/** Forgets drafts not edited for `KEPT_MS`, and anything under the prefix that is not a draft. */
export function forgetOldReplies(nowMs: number): void {
  for (const [id, value] of drafts) {
    if (!live(value.draft, nowMs)) drafts.delete(id);
  }
  for (const key of keptKeys(PREFIX)) {
    const draft = draftOf(readKept(key));
    if (!live(draft, nowMs)) writeKept(key, null);
  }
  changed();
}

/** The answer lines Copy takes: one per decision key, each with its reply after the colon. */
export function answerText(keys: string[], replies: string[]): string {
  return keys
    .map((key, i) => `answer ${key}: ${(replies[i] ?? "").trim()}`)
    .join("\n\n");
}

function readReplies(ids: string[]): string[] {
  return ids.map((id) => {
    const draft = drafts.get(id)?.draft ?? draftOf(readKept(id));
    return live(draft, Date.now()) ? draft.text : "";
  });
}

/** The drafts for one need's decision keys, and how to change one. */
export function useReplies(
  repo: string,
  keys: string[],
): [string[], (index: number, text: string) => void, boolean] {
  const joined = keys.map((key) => `${PREFIX}${repo} ${key}`).join("\n");
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const change = useCallback(
    (index: number, text: string) => {
      const id = joined.split("\n")[index];
      if (id === undefined) return;
      const draft = { text, at: Date.now() };
      const saved = writeKept(
        id,
        text.trim() === "" ? null : JSON.stringify(draft),
      );
      if (!saved) writeKept(id, null);
      drafts.set(id, { draft, saved });
      changed();
    },
    [joined],
  );
  return [
    readReplies(joined.split("\n")),
    change,
    joined.split("\n").every((id) => drafts.get(id)?.saved !== false),
  ];
}
