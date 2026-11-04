/**
 * The replies a person drafts beside a decision, kept in this browser alone so
 * a reload or the next read loses none of them. The page never sends one: Copy
 * puts the answer lines on the clipboard, to paste on the pull request.
 */
import { useCallback, useState } from "react";
import { keptKeys, readKept, writeKept } from "./kept.ts";

const PREFIX = "reply:";

/** How long a draft is kept after its last edit. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

interface Draft {
  text: string;
  at: number;
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
  for (const key of keptKeys(PREFIX)) {
    const draft = draftOf(readKept(key));
    if (draft === null || nowMs - draft.at > KEPT_MS) writeKept(key, null);
  }
}

/** The answer lines Copy takes: one per decision key, each with its reply after the colon. */
export function answerText(keys: string[], replies: string[]): string {
  return keys
    .map((key, i) => `answer ${key}: ${(replies[i] ?? "").trim()}`)
    .join("\n\n");
}

function readReplies(ids: string[]): string[] {
  return ids.map((id) => draftOf(readKept(id))?.text ?? "");
}

/** The drafts for one need's decision keys, and how to change one. */
export function useReplies(
  repo: string,
  keys: string[],
): [string[], (index: number, text: string) => void] {
  const joined = keys.map((key) => `${PREFIX}${repo} ${key}`).join("\n");
  const [held, setHeld] = useState(() => ({
    joined,
    replies: readReplies(joined.split("\n")),
  }));
  // A newer read can name other keys for the same need; their drafts replace these.
  if (held.joined !== joined)
    setHeld({ joined, replies: readReplies(joined.split("\n")) });
  const change = useCallback(
    (index: number, text: string) => {
      const id = joined.split("\n")[index];
      if (id === undefined) return;
      setHeld((now) => ({
        ...now,
        replies: now.replies.map((t, i) => (i === index ? text : t)),
      }));
      writeKept(
        id,
        text.trim() === "" ? null : JSON.stringify({ text, at: Date.now() }),
      );
    },
    [joined],
  );
  return [
    held.joined === joined ? held.replies : readReplies(joined.split("\n")),
    change,
  ];
}
