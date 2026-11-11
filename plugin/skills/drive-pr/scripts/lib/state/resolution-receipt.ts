/**
 * Resolution receipts: what a re-arm leaves in the drive state, and through
 * it in the drive ledger, for each park it unparks. A park leaves the ledger
 * answered, withdrawn or corrected alike, so the dispatcher's tick reads how
 * it left from its receipt, never from its disappearance
 * (design/structured-answers.md § Showing what was decided).
 *
 * A receipt names one park occurrence: its key, its digest and the time it
 * was parked, which `drive-state.ts park` assigns afresh each time an item is
 * parked again, so a decision parked and answered twice has two receipts. It
 * carries the answers the re-arm consumed, without their bodies (the pass
 * reads those from the kept answers, `pass-handoff.ts`), the outcome and the
 * times. `unpark --stdin` writes them in the same state mutation that removes
 * the parks, so a park never leaves the state without its receipt. The state
 * keeps the newest `RESOLVED_PARKS_KEPT`; optional in a stored state and a
 * ledger, where an older file reads as none.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { isDecisionDigest } from "../../../../../shared/decisions/digest.ts";
import { redact } from "../../../../../shared/redact.ts";
import type { PendingAnswer } from "./pass-handoff.ts";
import type { ParkedItem } from "./park-frame.ts";

/** How many receipts the state and the ledger keep, the newest last. */
export const RESOLVED_PARKS_KEPT = 10;

/** One answer the re-arm consumed, as the receipt keeps it: without its body. */
export type ReceiptAnswer = Omit<PendingAnswer, "body">;

/** How a park left: answered by people, or handed on to be decided provisionally. */
export type ReceiptOutcome = "answered" | "provisional";

export interface ResolutionReceipt {
  key: string;
  kind: "thread" | "finding";
  /** The decision's question, as the park held it. */
  reason: string;
  class?: string;
  digest?: string;
  /** When this occurrence was parked: with the key and digest, its identity. */
  parkedAt: string;
  outcome: ReceiptOutcome;
  answers: ReceiptAnswer[];
  /** The latest consumed answer's time; absent when none was consumed. */
  answeredAt?: string;
  /** When the re-arm unparked it. */
  resolvedAt: string;
}

/** What the re-arm hands `unpark --stdin` for each item: the verdict it read. */
export interface ConsumedVerdict {
  key: string;
  provisional?: true;
  answers: PendingAnswer[];
}

const isText = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is string =>
  isText(v) && Number.isFinite(Date.parse(v));

const optional =
  (check: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === undefined || check(v);

/** Whether `v` is a mapping each of whose listed fields passes its check. */
function hasFields(
  v: unknown,
  fields: Record<string, (field: unknown) => boolean>,
): boolean {
  return (
    isRecord(v) &&
    Object.entries(fields).every(([name, check]) => check(v[name]))
  );
}

const CHOICE_FIELDS = {
  option: isText,
  recommended: (v: unknown) => typeof v === "boolean",
  form: (v: unknown) => v === "approve" || v === "choose",
  digest: optional(isDecisionDigest),
  note: optional(isText),
};

const ANSWER_FIELDS = {
  author: isText,
  at: isTime,
  url: isText,
  bodyHash: optional(isText),
  digest: optional(isDecisionDigest),
  stale: optional((v) => v === true),
  choice: optional((v) => hasFields(v, CHOICE_FIELDS)),
};

function isReceiptAnswer(v: unknown): v is ReceiptAnswer {
  return hasFields(v, ANSWER_FIELDS);
}

const RECEIPT_FIELDS = {
  key: (v: unknown) => isText(v) && v !== "",
  kind: (v: unknown) => v === "thread" || v === "finding",
  reason: isText,
  class: optional(isText),
  digest: optional(isDecisionDigest),
  parkedAt: isTime,
  outcome: (v: unknown) => v === "answered" || v === "provisional",
  answers: (v: unknown) => Array.isArray(v) && v.every(isReceiptAnswer),
  answeredAt: optional(isTime),
  resolvedAt: isTime,
};

export function isResolutionReceipt(v: unknown): v is ResolutionReceipt {
  return hasFields(v, RECEIPT_FIELDS);
}

/** Absent, or a list of well-formed receipts. */
export function isOptionalResolvedParks(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isResolutionReceipt));
}

/** An answer the re-arm consumed: a receipt's answer, with the body the pass reads. */
function isConsumedAnswer(v: unknown): v is PendingAnswer {
  return isRecord(v) && isText(v.body) && isReceiptAnswer(v);
}

/** The verdicts `unpark --stdin` reads; a reason when the text is not them. */
export function parseConsumed(raw: string): ConsumedVerdict[] | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "unpark --stdin reads a JSON list of the verdicts the re-arm consumed";
  }
  const ok =
    Array.isArray(value) &&
    value.every(
      (v) =>
        isRecord(v) &&
        isText(v.key) &&
        (v.provisional === undefined || v.provisional === true) &&
        Array.isArray(v.answers) &&
        v.answers.every(isConsumedAnswer),
    );
  return ok
    ? (value as ConsumedVerdict[])
    : "unpark --stdin: each verdict needs a key and its answers";
}

/** An answer without its body: the receipt names the comment, the pass reads the words. */
function withoutBody(a: PendingAnswer): ReceiptAnswer {
  const { body: _body, ...rest } = a;
  return rest;
}

/**
 * The receipts for the parks an unpark removes, each with the verdict the
 * re-arm consumed for it. A park with no recorded time has no occurrence to
 * name and gets none; neither does one no verdict names.
 */
export function receiptsFor(
  removed: readonly ParkedItem[],
  consumed: readonly ConsumedVerdict[],
  resolvedAt: string,
): ResolutionReceipt[] {
  return removed.flatMap((p) => {
    const verdict = consumed.find((v) => v.key === p.key);
    if (p.at === undefined || verdict === undefined) return [];
    const answers = verdict.answers.map(withoutBody);
    const answeredAt = answers
      .map((a) => a.at)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1);
    return [
      {
        key: p.key,
        kind: p.kind,
        reason: p.reason,
        ...(p.class === undefined ? {} : { class: p.class }),
        ...(p.digest === undefined ? {} : { digest: p.digest }),
        parkedAt: p.at,
        outcome: verdict.provisional === true ? "provisional" : "answered",
        answers,
        ...(answeredAt === undefined ? {} : { answeredAt }),
        resolvedAt,
      },
    ];
  });
}

/** The kept receipts with `fresh` added: the newest `RESOLVED_PARKS_KEPT`, though never fewer than the whole fresh batch, which no reader has seen yet. */
export function keptReceipts(
  kept: readonly ResolutionReceipt[] | undefined,
  fresh: readonly ResolutionReceipt[],
): ResolutionReceipt[] {
  const room = Math.max(0, RESOLVED_PARKS_KEPT - fresh.length);
  return [...(kept ?? []).slice(room === 0 ? kept?.length : -room), ...fresh];
}

/** A receipt as the public ledger carries it: its question and notes redacted. */
export function redactedReceipt(r: ResolutionReceipt): ResolutionReceipt {
  return {
    ...r,
    reason: redact(r.reason),
    answers: r.answers.map((a) =>
      a.choice?.note === undefined
        ? a
        : { ...a, choice: { ...a.choice, note: redact(a.choice.note) } },
    ),
  };
}

/**
 * The identity of one park occurrence across every reader: the repository,
 * the pull request, the key, the digest (`-` for a park from before digests)
 * and the time it was parked.
 */
export function parkOccurrence(
  repo: string,
  pr: number,
  park: { key: string; digest?: string; parkedAt: string },
): string {
  return `${repo}#${pr} ${park.key} ${park.digest ?? "-"} ${park.parkedAt}`;
}
