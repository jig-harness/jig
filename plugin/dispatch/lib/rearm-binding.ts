import {
  type ClaimKind,
  type ClaimTarget,
  type Deadline,
  type ListedClaim,
  listedFrom,
  publish,
} from "../../shared/records/forge-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { parseMs } from "../../shared/time.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { Classified } from "./sources/ledgers.ts";
import type { Evidence } from "./types.ts";

export const REARM_REQUEST: ClaimKind = {
  name: "dispatch-rearm-request",
  opens: "<!-- jig-dispatch-rearm-request -->",
  data: "<!-- jig-dispatch-rearm-request-data",
};

export interface RearmStop {
  comment: number;
  generation: number;
}

/** The label is the delivery signal. Publish its binding before adding or removing it. */
export async function writeRearmBinding(
  target: ClaimTarget,
  login: string | null,
  label: string,
  stop: RearmStop | null,
  options: {
    requestId?: number;
    reason?: string;
    needsPerson?: true;
    failureStop?: RearmStop;
    deadline?: Deadline;
  } = {},
): Promise<Outcome<string | null, "refused">> {
  if (stop === null && options.requestId === undefined) return ok(null);
  const wrote = await publish(
    target,
    REARM_REQUEST,
    {
      key: "rearm",
      ...(stop === null ? {} : { generation: stop.generation }),
      writer: localWriter("forge", login),
      payload: {
        label,
        stopComment: stop?.comment ?? null,
        requestId: options.requestId,
        reason: options.reason,
        needsPerson: options.needsPerson,
        failureStop: options.failureStop?.comment,
        failureGeneration: options.failureStop?.generation,
      },
      text:
        stop === null
          ? (options.reason ?? "Withdrew the pending re-arm request.")
          : `Requested a re-arm of the drive stopped at ledger generation ${stop.generation}.`,
    },
    options.deadline,
  );
  return wrote.ok
    ? ok(wrote.value.url)
    : failed(
        "refused",
        `the rearm request record could not be written: ${wrote.failure.reason}`,
        wrote.failure.cause,
      );
}

/** These stops cannot be restarted through a person's pending re-arm request. */
export function rearmableStop(ledger: Ledger): boolean {
  const { state, exit, personStop } = ledger.driver;
  return (
    state === "stopped" &&
    personStop === undefined &&
    exit !== DRIVE_EXIT.CONVERGED &&
    exit !== DRIVE_EXIT.PR_NOT_OPEN &&
    exit !== DRIVE_EXIT.TAKEN_OVER &&
    exit !== DRIVE_EXIT.MAILBOX_STOPPED &&
    exit !== DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT
  );
}

type Payload = {
  reason?: unknown;
  needsPerson?: unknown;
  failureStop?: unknown;
  failureGeneration?: unknown;
};

/** A request a person withdrew, or that the drive itself ended with a failure to report. */
function cancelledEvidence(
  evidence: Evidence,
  payload: Payload,
  stop: RearmStop | null,
  sameStop: boolean,
): Evidence {
  const { reason, needsPerson, failureStop, failureGeneration } = payload;
  const atFailure =
    stop !== null &&
    stop.comment === failureStop &&
    stop.generation === failureGeneration;
  const report = (sameStop || atFailure) && needsPerson === true;
  return {
    ...evidence,
    rearmCancelled: true,
    ...(report && typeof reason === "string" ? { rearmFailure: reason } : {}),
    rearmExpired:
      typeof reason === "string"
        ? reason
        : "the person withdrew the rearm request",
  };
}

/** A request whose stop the drive has moved past. */
function movedEvidence(evidence: Evidence, stop: RearmStop | null): Evidence {
  return {
    ...evidence,
    rearmExpired:
      "the drive is no longer at the stop named by the rearm request",
    ...(stop !== null
      ? {
          rearmMoved: true,
          rearmMovedTo: stop.comment,
          rearmMovedGeneration: stop.generation,
        }
      : {}),
  };
}

/** Read the newest trusted binding for the carried label from the tick's comment listing. */
export function rearmBinding(
  target: ClaimTarget,
  login: string | null,
  comments: readonly unknown[],
  label: string,
  stop: RearmStop | null,
): Evidence {
  const records = rearmRecords(target, login, comments, label);
  const newest = latestRequest(records);
  const evidence = {
    rearmLabel: label,
    ...(newest === undefined ? {} : { rearmRequestId: newest.id }),
  };
  if (newest === undefined || !newest.record.ok)
    return {
      ...evidence,
      rearmExpired: "the rearm label has no readable request binding",
    };
  const { generation, payload, at } = newest.record.value;
  const cancelled = records.findLast(
    ({ id, record }) =>
      id > newest.id &&
      record.ok &&
      record.value.payload.stopComment === null &&
      record.value.payload.requestId === newest.id,
  );
  const sameStop =
    stop !== null &&
    payload.stopComment === stop.comment &&
    generation === stop.generation;
  if (cancelled?.record.ok)
    return cancelledEvidence(
      evidence,
      cancelled.record.value.payload,
      stop,
      sameStop,
    );
  const requestedAt = parseMs(newest.createdAt || at);
  if (!sameStop) return movedEvidence(evidence, stop);
  if (!Number.isFinite(requestedAt))
    return { ...evidence, rearmExpired: "the rearm request time did not read" };
  return {
    ...evidence,
    rearm: true,
    rearmRequestedAt: requestedAt,
    noCause: false,
    legacyNoCause: false,
  };
}

/** Find the request or cancellation a person would act on. */
export function latestRearmBinding(
  target: ClaimTarget,
  login: string | null,
  comments: readonly unknown[],
  label: string,
): ListedClaim | undefined {
  return latestRequest(rearmRecords(target, login, comments, label));
}

function rearmRecords(
  target: ClaimTarget,
  login: string | null,
  comments: readonly unknown[],
  label: string,
): ListedClaim[] {
  return listedFrom(REARM_REQUEST, comments, target, login).filter(
    ({ trusted, record }) =>
      trusted && (!record.ok || record.value.payload.label === label),
  );
}

function latestRequest(
  records: readonly ListedClaim[],
): ListedClaim | undefined {
  return records.findLast(
    ({ record }) => !record.ok || record.value.payload.stopComment !== null,
  );
}

/** What the request changes about the stop, leaving unresolved parks on the notification path. */
export function classifyRearm(
  classified: Classified,
  request: Evidence,
): Classified {
  if (classified.class === "unplaced") return classified;
  if (classified.class === "parked")
    return request.rearm === true
      ? {
          ...classified,
          why: `${classified.why}. The explicit re-arm request ${String(request.rearmRequestId ?? "unknown")} cannot proceed while a park still needs a current answer`,
        }
      : classified;
  if (typeof request.rearmFailure === "string")
    return { class: "needs-person", why: request.rearmFailure };
  if (request.rearm === true)
    return {
      class: "re-armable",
      why: "a person's rearm request asks to restart this stopped drive in its existing tree",
    };
  return classified;
}
