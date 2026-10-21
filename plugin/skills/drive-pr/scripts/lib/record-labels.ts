/**
 * A thread record's `severity` and `category`, as `self-inflicted.ts` appends
 * them to each record of `list-unresolved-threads.ts`'s stream: from the
 * code scanning alert behind a code-scanning thread, else from the thread's
 * first comment.
 */
import { categoryOf, severityOf } from "../summary-findings.ts";

/** The part of a thread record the labels are read from. */
export interface LabelledRecord {
  /** The thread's comments, the finding first. */
  comments?: unknown;
  /**
   * The code scanning alert behind a code-scanning thread, as
   * `list-unresolved-threads.ts` attaches it: its `severity` and `category`
   * come from the alert, since the alert's comment states neither.
   */
  codeScanning?: unknown;
}

/**
 * A code-scanning thread's `severity` or `category`, when its alert was read
 * and the value is one of `allowed`; else `null`, and the comment is read as
 * any other thread's.
 */
function alertLabel(
  rec: LabelledRecord,
  key: "severity" | "category",
  allowed: readonly string[],
): string | null {
  const alert = rec.codeScanning;
  if (typeof alert !== "object" || alert === null) return null;
  const value = (alert as Record<string, unknown>)[key];
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/**
 * The thread's FIRST comment — the reviewer's original finding — as its body
 * and author, or `null` when it has no readable body. Never a later reply: a
 * human or bot reply in the same thread carries no severity or category of
 * its own, and reading one would label the finding with text that was never
 * about it.
 */
function finding(
  rec: LabelledRecord,
): { body: string; author: string | null } | null {
  const comments = rec.comments;
  if (!Array.isArray(comments) || comments.length === 0) return null;
  const first: unknown = comments[0];
  if (typeof first !== "object" || first === null) return null;
  const { body, author } = first as { body?: unknown; author?: unknown };
  if (typeof body !== "string") return null;
  // `list-unresolved-threads.ts` emits the author as the plain GraphQL login
  // (or `null`), so it lines up with the logins the severity formats name.
  return { body, author: typeof author === "string" ? author : null };
}

/**
 * The finding's own severity, mechanized at enumeration rather than left to the
 * triaging agent to read `severityOf`'s recognized shapes off the raw comment
 * text by hand — a step that silently reads `unknown` for a reviewer whose
 * format `severityOf` doesn't recognize, sending every one of that reviewer's
 * findings through the ladder's `inert_when_unknown` fail-open path. The
 * author is threaded through so a reviewer's format only ever reads a comment
 * that reviewer posted, not merely one shaped like it.
 */
export function severityOfRecord(rec: LabelledRecord): string {
  const fromAlert = alertLabel(rec, "severity", [
    "blocker",
    "high",
    "medium",
    "low",
  ]);
  if (fromAlert !== null) return fromAlert;
  const f = finding(rec);
  return f === null ? "unknown" : severityOf(f.body, f.author);
}

/** The finding's own category, mechanized the same way as its severity. */
export function categoryOfRecord(rec: LabelledRecord): string {
  const fromAlert = alertLabel(rec, "category", ["security"]);
  if (fromAlert !== null) return fromAlert;
  const f = finding(rec);
  return f === null ? "unknown" : categoryOf(f.body);
}
