/**
 * The head of a pull request's base branch, read for a ledger whose stop a
 * conflict re-drives, held to the tick's bound.
 */
import type { ReadFailure } from "../types.ts";
import { branchHead } from "../forge.ts";
import { heldRead, secondsLeft, type TickBound } from "./bounded.ts";
import { readFailureOf, readFailureOfError } from "../read-failures.ts";
import { failureText } from "../text.ts";

/** What the head of a pull request's base branch read as; where it did not, the failed call's class. */
export type BaseHead =
  | { oid: string }
  | { unreadable: string; failure?: ReadFailure };

/** The `failure` field of a failed read with a class; nothing without one. */
export const classed = (failure: ReadFailure | undefined) =>
  failure === undefined ? {} : { failure };

/** Runs a forge read when the tick's pool has a place for it (`pool.ts`). */
export type Admit = <T>(read: () => Promise<T>) => Promise<T>;

/** A reading's reader of base branch heads: pull requests on one base share one read, none started once `bound` has ended. */
export function baseHeads(
  slug: string,
  admit: Admit,
  bound: TickBound | undefined,
): (branch: string | undefined) => Promise<BaseHead> {
  const read = new Map<string, Promise<BaseHead>>();
  return (branch) => {
    if (branch === undefined || branch === "")
      return Promise.resolve({
        unreadable: "the forge reports no base branch for it",
      });
    const known = read.get(branch);
    if (known !== undefined) return known;
    const head = admit(() =>
      heldRead(bound, `the head of base branch ${branch} was read`, () =>
        branchHead(slug, branch, secondsLeft(bound)),
      ),
    ).then(
      (oid): BaseHead =>
        oid.ok
          ? { oid: oid.value }
          : {
              unreadable: oid.failure.reason,
              ...classed(readFailureOf(oid.failure)),
            },
      (error: unknown): BaseHead => ({
        unreadable: failureText(error),
        ...classed(readFailureOfError(error)),
      }),
    );
    read.set(branch, head);
    return head;
  };
}
