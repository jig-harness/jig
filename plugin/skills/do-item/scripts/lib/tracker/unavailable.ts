import { isRateLimited } from "../../../../../shared/tracker-budget.ts";
import { FacetReadStopped } from "./facets/bounds.ts";
import { LinearApiError } from "./linear-transport.ts";

/** Whether a failure says the tracker could not be asked or answered, not that a request was wrong. */
export function isUnavailable(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { unavailable?: unknown }).unavailable === true ||
      isRateLimited(err) ||
      err instanceof FacetReadStopped ||
      (err instanceof LinearApiError && linearUnanswered(err)) ||
      err.name === "AbortError" ||
      err.name === "TimeoutError")
  );
}

/** A Linear failure with no answer (network, timeout, cancellation), or a rate-limit or server refusal. */
function linearUnanswered(err: LinearApiError): boolean {
  return err.status === null || err.status === 429 || err.status >= 500;
}

/** A configured store's health; `unavailable` marks a probe the tracker could not answer. */
export type StoreHealth =
  | { status: "ok" }
  | { status: "failed"; error: string; unavailable?: boolean };

/** The failed health a thrown probe error stands for. */
export function failedHealth(err: unknown): StoreHealth {
  return {
    status: "failed",
    unavailable: isUnavailable(err),
    error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  };
}
