/**
 * The page's edge to its server: one read per route. Each turns whatever
 * happened into a value of one closed union, so a failure is something the page
 * shows rather than something it catches: the server gone, the token refused, a
 * coded failure, or the answer.
 */
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

export function isStateAnswer(value: unknown): value is StateAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "now" in value &&
    typeof value.now === "string" &&
    "timeZone" in value &&
    typeof value.timeZone === "string" &&
    "schema" in value &&
    typeof value.schema === "number" &&
    "line" in value &&
    typeof value.line === "object"
  );
}

export function isRowsAnswer(value: unknown): value is RowsAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    typeof value.from === "string" &&
    "to" in value &&
    typeof value.to === "string" &&
    "rows" in value &&
    Array.isArray(value.rows) &&
    "recurring" in value &&
    Array.isArray(value.recurring) &&
    "counts" in value &&
    typeof value.counts === "object" &&
    "options" in value &&
    typeof value.options === "object"
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

async function read<T>(
  url: string,
  reads: (value: unknown) => value is T,
): Promise<ReadResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return resultOf(response.status, await response.json(), reads);
  } catch (cause) {
    // A body that is not JSON was answered and cannot be read; anything else is
    // the connection ending before an answer arrived.
    return cause instanceof SyntaxError ? UNREADABLE : { kind: "gone" };
  }
}

/** `GET /state`. */
export function readState(token: string): Promise<ReadResult<StateAnswer>> {
  return read(`/state?token=${encodeURIComponent(token)}`, isStateAnswer);
}

/** `GET /rows`, for a filter already written as a query. */
export function readRows(
  token: string,
  query: string,
): Promise<ReadResult<RowsAnswer>> {
  return read(
    `/rows?token=${encodeURIComponent(token)}&${query}`,
    isRowsAnswer,
  );
}

/** Where the newest tick's receipt is served. */
export function receiptUrl(token: string): string {
  return `/receipt?token=${encodeURIComponent(token)}`;
}
