/**
 * The name the page gives a repository's tracker, from the adapter its
 * configuration names (`LineRepo.tracker`): the product a person knows,
 * not the configuration's word for it. Where the line does not say, the page
 * speaks of the repository's issues, never of a "tracker".
 */
import type {
  LineRepo,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { trackerProduct } from "../../plugin/shared/tracker-product.ts";

/** A repository's tracker as the line holds it: `null` when its setting does not read, `undefined` when the line does not say. */
export type Tracker = LineRepo["tracker"] | undefined;

/** What one item of each tracker is called, and how its link out reads. */
const ITEM_WORDS: Readonly<Record<string, { kind: string; open: string }>> = {
  github: { kind: "GitHub issue", open: "Open on GitHub" },
  linear: { kind: "Linear issue", open: "Open in Linear" },
  jira: { kind: "Jira issue", open: "Open in Jira" },
};

/** A tracker's name for a person; an adapter the page does not know by its own word; `null` when the line does not say. */
export function trackerName(tracker: Tracker): string | null {
  return tracker == null ? null : trackerProduct(tracker.adapter);
}

/** The tracker a repository's configuration names, as the line holds it; `undefined` when the line does not hold the repository or a line written before it was kept. */
export function trackerOf(line: LineSnapshot | null, repo: string): Tracker {
  return line?.repos.find((r) => r.slug === repo)?.tracker;
}

/** How the page names one item and its link out, for a repository's tracker. */
export interface ItemWords {
  /** The tracker's name for a person; `null` when the line does not say. */
  name: string | null;
  /** What the item is: "Linear issue", or "Issue" where the line does not say. */
  kind: string;
  /** Why the kind has no product, when it has none. */
  unnamed: string | null;
  /** The link out: "Open in Linear", or "Open the issue". */
  open: string;
  /** Where to look an item up with no link: "Linear", or "its repository's issues". */
  where: string;
}

export function itemWords(tracker: Tracker): ItemWords {
  const name = trackerName(tracker);
  const adapter = tracker?.adapter.toLowerCase() ?? "";
  const words = Object.hasOwn(ITEM_WORDS, adapter)
    ? ITEM_WORDS[adapter]
    : undefined;
  const unnamed =
    tracker === null
      ? "this repository's issue setting does not read"
      : tracker === undefined
        ? "where this repository keeps its issues is not in this read"
        : null;
  return {
    name,
    kind: words?.kind ?? (name === null ? "Issue" : `${name} issue`),
    unnamed,
    open: words?.open ?? (name === null ? "Open the issue" : `Open in ${name}`),
    where: name ?? "its repository's issues",
  };
}
