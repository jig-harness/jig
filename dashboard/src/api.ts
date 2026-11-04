/**
 * The page's edge to its server: one read per route. Each turns whatever
 * happened into a value of one closed union, so a failure is something the page
 * shows rather than something it catches: the server gone, the token refused, a
 * coded failure, or the answer.
 */
import { isRecord } from "../../plugin/shared/guards.ts";
import type {
  RowsAnswer,
  StateAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";

/** A read that gave no answer. */
export type ReadFailure =
  /** The fetch itself failed: nothing answered. */
  | { kind: "gone" }
  /** The server refused the token. */
  | { kind: "refused"; reason: string }
  /** The server answered with a coded failure. */
  | { kind: "failed"; code: string; reason: string };

export type ReadResult<T> = { kind: "answer"; value: T } | ReadFailure;

/**
 * TanStack Query reads a rejected promise as its failed state, so `answerOf` is
 * the one place a failure value crosses into a rejection, carrying the value
 * through this class. Nothing else in the page throws for a failed read.
 */
export class ReadRejected extends Error {
  override name = "ReadRejected";
  readonly failure: ReadFailure;
  constructor(failure: ReadFailure) {
    super(`the read failed: ${failure.kind}`);
    this.failure = failure;
  }
}

/** A result's answer, or the rejection TanStack Query reads as failed. */
export function answerOf<T>(result: ReadResult<T>): T {
  if (result.kind === "answer") return result.value;
  throw new ReadRejected(result);
}

const UNREADABLE: ReadFailure = {
  kind: "failed",
  code: "answer-unreadable",
  reason: "the server's answer is not in a form this page reads",
};

function isCodedFailure(
  body: unknown,
): body is { ok: false; failure: { code: string; reason: string } } {
  if (typeof body !== "object" || body === null) return false;
  if (!("ok" in body) || body.ok !== false || !("failure" in body))
    return false;
  const failure = body.failure;
  return (
    typeof failure === "object" &&
    failure !== null &&
    "code" in failure &&
    typeof failure.code === "string" &&
    "reason" in failure &&
    typeof failure.reason === "string"
  );
}

/** The value an `ok` answer carries; `undefined` when the body is not one. */
function okValue(body: unknown): unknown {
  return typeof body === "object" &&
    body !== null &&
    "ok" in body &&
    body.ok === true &&
    "value" in body
    ? body.value
    : undefined;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** A zone the browser can show times in: the host names its own by the canonical name the browser lists, or UTC. */
function isZone(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "UTC" || Intl.supportedValuesOf("timeZone").includes(value))
  );
}

function areRecords(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRecord);
}

/** A line the page can lay out: the sections it walks are arrays of records, and the times it formats read. */
function isLine(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    isTime(value.startedAt) &&
    isTime(value.finishedAt) &&
    typeof value.intervalMs === "number" &&
    Number.isFinite(value.intervalMs) &&
    ["accounts", "sessions", "needs", "queue", "repos"].every((section) =>
      areRecords(value[section]),
    ) &&
    (value.needs as Array<Record<string, unknown>>).every(
      (need) => isTime(need.since) && Array.isArray(need.decisions),
    ) &&
    (value.sessions as Array<Record<string, unknown>>).every((session) =>
      isTime(session.createdAt),
    )
  );
}

export function isStateAnswer(value: unknown): value is StateAnswer {
  return (
    isRecord(value) &&
    isTime(value.now) &&
    isZone(value.timeZone) &&
    typeof value.schema === "number" &&
    "line" in value &&
    isLine(value.line)
  );
}

export function isRowsAnswer(value: unknown): value is RowsAnswer {
  return (
    isRecord(value) &&
    typeof value.window === "string" &&
    isTime(value.from) &&
    isTime(value.to) &&
    areRecords(value.rows) &&
    areRecords(value.recurring) &&
    isRecord(value.counts) &&
    Object.values(value.counts).every((n) => typeof n === "number") &&
    typeof value.total === "number" &&
    typeof value.truncated === "boolean" &&
    isRecord(value.options) &&
    ["repo", "stage", "account", "class"].every((field) =>
      Array.isArray((value.options as Record<string, unknown>)[field]),
    )
  );
}

/** What a response's status and body mean, once the body has been read. */
export function resultOf<T>(
  status: number,
  body: unknown,
  reads: (value: unknown) => value is T,
): ReadResult<T> {
  if (isCodedFailure(body))
    return status === 403 && body.failure.code === "token-refused"
      ? { kind: "refused", reason: body.failure.reason }
      : {
          kind: "failed",
          code: body.failure.code,
          reason: body.failure.reason,
        };
  const value = okValue(body);
  return reads(value) ? { kind: "answer", value } : UNREADABLE;
}

/** How long one read may take, its body included. */
const READ_DEADLINE_MS = 15_000;

async function read<T>(
  url: string,
  reads: (value: unknown) => value is T,
  signal?: AbortSignal,
): Promise<ReadResult<T>> {
  const deadline = AbortSignal.timeout(READ_DEADLINE_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal:
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    });
    return resultOf(response.status, await response.json(), reads);
  } catch (cause) {
    // A body that is not JSON was answered and cannot be read; anything else is
    // the connection ending, or the deadline passing, before an answer arrived.
    return cause instanceof SyntaxError ? UNREADABLE : { kind: "gone" };
  }
}

/** `GET /state`. */
export function readState(
  token: string,
  signal?: AbortSignal,
): Promise<ReadResult<StateAnswer>> {
  return read(
    `/state?token=${encodeURIComponent(token)}`,
    isStateAnswer,
    signal,
  );
}

/** `GET /rows`, for a filter already written as a query. */
export function readRows(
  token: string,
  query: string,
  signal?: AbortSignal,
): Promise<ReadResult<RowsAnswer>> {
  return read(
    `/rows?token=${encodeURIComponent(token)}&${query}`,
    isRowsAnswer,
    signal,
  );
}

/** Where the receipt of tick `runId` is served: the server answers a newer tick's with a refusal that says so. */
export function receiptUrl(token: string, runId: string): string {
  return `/receipt?token=${encodeURIComponent(token)}&run=${encodeURIComponent(runId)}`;
}
