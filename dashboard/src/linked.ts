/**
 * The work a card is linked to, from the line's `links` field: for a pull
 * request, the items it closes or was opened from; for an item, the open pull
 * requests that close it. A row with no `links` is one the tick could not
 * tell, which is not the same as one it found none for, so the page says
 * which case holds.
 */
import type { LineLinks } from "../../plugin/dispatch/lib/dashboard-contract.ts";

/** Linked work a card's face shows before "+N more". */
const LINKED_SHOWN = 2;

/** One piece of linked work, as its identity draws it. */
export interface LinkedRef {
  /** `PR #7` or the item's key, as a target reads elsewhere on the page. */
  target: string;
  url: string | null;
  /** Whether it is a pull request; the contract names only open ones for an item. */
  pr: boolean;
}

export interface LinkedWork {
  /** `unknown`: the line does not say; `none`: it found none; `some`: `all` holds them. */
  state: "unknown" | "none" | "some";
  all: LinkedRef[];
  /** What the face shows, at most `LINKED_SHOWN`. */
  shown: LinkedRef[];
  /** How many the face leaves to the popover and the open card. */
  more: number;
  /** What the popover and the open card say after "Linked work:". */
  sentence: string;
}

/** The words for each case, so the page and its tests say them the same way. */
export const LINKED_WORDS = {
  unknown: "not known for this read.",
  nonePr: "none found.",
  noneItem: "none found among this repository's open pull requests.",
} as const;

/** A target's linked work; `self` is left out, should a record name it. */
export function linkedWork(
  target: string,
  links: LineLinks | undefined,
): LinkedWork {
  const isPr = /^PR #\d+$/.test(target);
  if (links === undefined)
    return {
      state: "unknown",
      all: [],
      shown: [],
      more: 0,
      sentence: LINKED_WORDS.unknown,
    };
  const all: LinkedRef[] = [
    ...links.items.map((i) => ({ target: i.key, url: i.url, pr: false })),
    ...links.prs.map((p) => ({
      target: `PR #${p.number}`,
      url: p.url,
      pr: true,
    })),
  ].filter(
    (ref, at, refs) =>
      ref.target !== target &&
      refs.findIndex((other) => other.target === ref.target) === at,
  );
  if (all.length === 0)
    return {
      state: "none",
      all,
      shown: [],
      more: 0,
      sentence: isPr ? LINKED_WORDS.nonePr : LINKED_WORDS.noneItem,
    };
  return {
    state: "some",
    all,
    shown: all.slice(0, LINKED_SHOWN),
    more: Math.max(0, all.length - LINKED_SHOWN),
    sentence: `${all.map((ref) => ref.target).join(", ")}.`,
  };
}
