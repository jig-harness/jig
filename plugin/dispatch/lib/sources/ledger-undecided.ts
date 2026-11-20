import type { Classified } from "./ledgers.ts";

/** An `unplaced` class whose forge facts a later tick reads again. */
export const undecided = (why: string): Classified => ({
  class: "unplaced",
  why,
  forgeUndecided: true,
});
