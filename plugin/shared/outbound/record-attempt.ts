/** Per-attempt accounting shared by the transports, including an attempt the budget refused locally. */
import { failureOf, type FailureClass } from "./failure.ts";
import { recordCall } from "./ledger.ts";
import { currentMs } from "../time.ts";

export interface Attempt {
  system: string;
  credential: string;
  operation: string;
  /** The repository the attempt addressed, `owner/name`, where it is known. */
  repository?: string | null;
  requests: number;
  /** Of `requests`, how many a conditional request had answered `304 Not Modified`. */
  notModified?: number;
  cost: number | null;
  unit: string;
  estimated: boolean;
  /** The quota owner's record key, where the system keeps one apart from the credential. */
  owner?: string | null;
  /** The window of that record the attempt spent; `unknown` when no evidence names it. */
  window?: string | null;
}

interface AttemptEvent extends Attempt {
  durationMs: number;
  failure: FailureClass | null;
}

/** Measure one actual attempt; a refused admission keeps its request count at zero. */
export async function recordAttempt<T>(
  observation: Attempt,
  send: () => Promise<T>,
  failed: (answer: T) => FailureClass | null,
): Promise<T> {
  const began = currentMs();
  let failure: FailureClass | null = null;
  try {
    const answer = await send();
    failure = failed(answer);
    return answer;
  } catch (error) {
    failure = failureOf(error).code;
    throw error;
  } finally {
    const event: AttemptEvent = {
      ...observation,
      durationMs: currentMs() - began,
      failure,
    };
    recordCall(event);
  }
}
