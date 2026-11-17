/** A footprint's finite comment population, shared by GraphQL and REST pagers. */
import { AsyncLocalStorage } from "node:async_hooks";
import { OutboundError } from "../../../../../shared/outbound/failure.ts";

const scope = new AsyncLocalStorage<{ left: number }>();
/** Existing adapters page comments in at most 100 nodes; ten pages bound the whole read. */
export const FOOTPRINT_MAX_PAGES = 10;
export function withCommentBound<T>(fn: () => T): T {
  return scope.run({ left: FOOTPRINT_MAX_PAGES }, fn);
}
/** A partial population must never select an older prediction as if it were newest. */
export function admitCommentPage(): void {
  const bound = scope.getStore();
  if (bound !== undefined && bound.left-- <= 0)
    throw new OutboundError(
      "too-costly",
      "footprint comment read exceeds ten pages",
    );
}
