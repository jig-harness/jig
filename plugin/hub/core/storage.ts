/**
 * The storage port: named operations on the hub's tables
 * ([design/control-plane.md § Storage](../../../design/control-plane.md#storage)).
 *
 * The core never writes a query. It names an operation the storage
 * implementation holds (`grantLease`, `recordDelivery`) and passes its
 * input; one implementation of every operation serves every adapter. A
 * read reads; a change is atomic within its partition, so a decision sits
 * in the change's own condition (a lease granted only where it is free),
 * never in code between a read and a write, and no change spans an await.
 * A change of several statements is one named operation, its statements
 * prepared before the first is sent and committed together.
 */
import type { Outcome } from "../../shared/outcome.ts";
import type { UnitContext } from "./unit.ts";

/**
 * How a storage call fails: the store could not be reached or opened
 * (`unavailable`), the unit's signal stopped the call (`aborted`), or the
 * store refused the operation (`refused`: an operation it does not hold,
 * or input that breaks a constraint). A change whose condition did not
 * hold is no failure: the operation's result says it was not applied.
 */
export type StorageFailureCode = "unavailable" | "aborted" | "refused";

/** Whether an operation reads or changes the tables. */
export type OperationKind = "read" | "change";

/**
 * A named operation, typed by its input and its result. The types exist
 * only for the type check: at run time an operation is its name and kind.
 */
export interface StorageOperation<Input, Result> {
  readonly name: string;
  readonly kind: OperationKind;
  /** Never set; carries the operation's types. */
  readonly types?: { input: Input; result: Result };
}

/** A named operation of `kind`, typed by its input and its result. */
export function operation<Input, Result>(
  name: string,
  kind: OperationKind,
): StorageOperation<Input, Result> {
  return { name, kind };
}

export interface StoragePort {
  /**
   * Runs `op` in `partition` (a repository's or the hub's own), atomically
   * for a change. A partition is the unit of atomicity: no operation
   * spans two.
   */
  run<Input, Result>(
    context: UnitContext,
    partition: string,
    op: StorageOperation<Input, Result>,
    input: Input,
  ): Promise<Outcome<Result, StorageFailureCode>>;
}
