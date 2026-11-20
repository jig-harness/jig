import type { PrFacts } from "./ledgers.ts";

/** A pull request's readable head and conflict state, or why either is unavailable. */
export function readFacts({
  head,
  mergeable,
}: PrFacts): { head: string; conflicting: boolean } | { unread: string } {
  if (mergeable === "UNKNOWN")
    return {
      unread: "the forge is still computing whether it conflicts with its base",
    };
  if (mergeable !== "MERGEABLE" && mergeable !== "CONFLICTING")
    return {
      unread: `the forge reports its mergeability as ${String(mergeable)}`,
    };
  if (head === null || head === "")
    return { unread: "the forge reports no head commit for it" };
  return { head, conflicting: mergeable === "CONFLICTING" };
}
