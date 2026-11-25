/**
 * How many launches of one drive in a row may end the same way before the
 * drive is a person's (`repeated-ends.ts`). Launch record retention
 * (`launch-keep.ts`) keeps that many records at the tail of a drive, so it
 * reads these without the settlement's imports.
 */

/** The re-arms that may stop `NOT_SETTLED` on one head before the drive is a person's. */
export const NOT_SETTLED_REARMS = 3;
/** The takeovers that may fail on one set of ledger facts before the drive is a person's. */
export const FAILED_TAKEOVERS = 3;
