/**
 * The freshness guard for a decision source: every claim's citation, checked
 * against `verifiedAt.commit` by the sheet kit (`../sheet-kit/freshness.ts`).
 */
import {
  checkFreshness as checkCitations,
  citedPaths as citedPathsOf,
  type Freshness,
} from "../sheet-kit/freshness.ts";
import type { DecisionSource } from "./source.ts";

export type { Freshness };

function claimSources(source: DecisionSource): string[] {
  return [
    ...source.currentBehaviour,
    ...(source.settled ?? []),
    ...source.calls.flatMap((call) => call.facts ?? []),
  ].map((claim) => claim.source);
}

export const citedPaths = (source: DecisionSource): string[] =>
  citedPathsOf(claimSources(source));

/**
 * Throws when the verified commit is unknown to this clone: then nothing was
 * compared, and "no change" would be a guess.
 */
export const checkFreshness = (
  source: DecisionSource,
  repoRoot: string,
  adrDirectory?: string,
): Freshness =>
  checkCitations(
    claimSources(source),
    source.verifiedAt.commit,
    repoRoot,
    adrDirectory,
  );
