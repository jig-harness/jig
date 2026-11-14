import {
  clearsByWaiting,
  failureOf,
} from "../../../../../shared/outbound/failure.ts";
import { FacetReadStopped } from "./facets/bounds.ts";

/**
 * Whether a failure says the tracker could not be asked or answered, not
 * that a request was wrong: its failure class (`shared/outbound/failure.ts`)
 * clears by waiting, or a facet read stopped at its deadline.
 */
export function isUnavailable(err: unknown): boolean {
  return (
    err instanceof FacetReadStopped || clearsByWaiting(failureOf(err).code)
  );
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
