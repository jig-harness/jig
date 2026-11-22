import { type RefObject, useEffect, useState } from "react";
import {
  type CardFilter,
  EMPTY_CARD_FILTER,
  type Facet,
  type FilterProjection,
  FACETS,
  facetsFor,
  projectFilters,
  readFacetAttrs,
} from "./facets.ts";
import { rove } from "./keys.ts";
import { reasonCounts } from "./queue-view.ts";
import { FILTERED_VIEWS, type ViewId } from "./search.ts";

export interface Oldest {
  age: string;
  target: string;
  url: string | null;
}

export interface FilterResults {
  total: number;
  shown: number;
  active: boolean;
  counts: FilterProjection["counts"];
  oldest: Oldest | null;
}

const EMPTY: FilterResults = {
  total: 0,
  shown: 0,
  active: false,
  counts: {},
  oldest: null,
};

function oldestOf(cards: readonly HTMLElement[]): Oldest | null {
  let oldest: HTMLElement | null = null;
  let since = Number.POSITIVE_INFINITY;
  for (const card of cards) {
    const time = Date.parse(card.dataset.facetSince ?? "");
    if (!(time < since)) continue;
    oldest = card;
    since = time;
  }
  if (oldest === null) return null;
  const {
    facetAgeLabel: age = "",
    facetTarget: target = "",
    pr,
    issue,
  } = oldest.dataset;
  return { age, target, url: pr ?? issue ?? null };
}

function textIn(group: HTMLElement, selector: string, text: string): void {
  const target = group.querySelector<HTMLElement>(selector);
  const node = target?.firstChild;
  if (node?.nodeType === Node.TEXT_NODE && node.nodeValue !== text)
    node.nodeValue = text;
}

function applyGroupFilter(root: HTMLElement, active: boolean): void {
  for (const group of root.querySelectorAll<HTMLElement>(
    "[data-facet-group]",
  )) {
    const visible = [
      ...group.querySelectorAll<HTMLElement>("[data-card]"),
    ].filter((card) => !card.hidden);
    const hide = active && visible.length === 0;
    if (group.hidden !== hide) group.hidden = hide;
    // A question group's card counts each target it holds (`data-needs`).
    const needs = visible.reduce(
      (n, card) => n + (Number(card.dataset.needs) || 1),
      0,
    );
    textIn(group, "[data-group-count]", String(needs));
    const oldest = oldestOf(visible);
    textIn(
      group,
      "[data-group-oldest]",
      oldest === null ? "" : `Oldest ${oldest.age}`,
    );
    textIn(
      group,
      "[data-group-why]",
      reasonCounts(visible.flatMap((card) => card.dataset.groupWhy ?? [])),
    );
  }
}

function applyFilters(
  element: HTMLElement,
  filter: CardFilter,
  facets: readonly Facet[],
): FilterResults {
  const cards = [...element.querySelectorAll<HTMLElement>("[data-card]")];
  const projection = projectFilters(
    cards.map((card) => ({
      text: card.textContent ?? "",
      values: readFacetAttrs(card, facets),
    })),
    filter,
    facets,
  );
  const visible = cards.filter((card, index) => {
    const keep = projection.matching[index] === true;
    if (card.hidden === keep) card.hidden = !keep;
    return keep;
  });
  // A filter can reach cards beyond the initial limit of a long list.
  element.classList.toggle("filtering", projection.active);
  applyGroupFilter(element, projection.active);
  rove(element);
  return {
    total: cards.length,
    shown: visible.length,
    active: projection.active,
    counts: projection.counts,
    oldest: oldestOf(visible),
  };
}

/** The view's text is already rendered into cards. Reuse it for search and attach structured values for facets. */
export function useFilterResults(
  root: RefObject<HTMLElement | null>,
  filter: CardFilter,
  view: ViewId,
): FilterResults {
  const [result, setResult] = useState<FilterResults>(EMPTY);
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const applied = FILTERED_VIEWS.has(view) ? filter : EMPTY_CARD_FILTER;
    const facets = facetsFor(view);
    let previous = "";
    const apply = () => {
      const next = applyFilters(element, applied, facets);
      const snapshot = JSON.stringify(next);
      if (previous === snapshot) return;
      previous = snapshot;
      setResult(next);
    };
    apply();
    const watcher = new MutationObserver(apply);
    watcher.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: [
        ...FACETS.map((facet) => `data-facet-${facet}`),
        "data-facet-since",
        "data-facet-age-label",
        "data-group-why",
        "hidden",
        "aria-expanded",
      ],
    });
    return () => watcher.disconnect();
  }, [root, filter, view]);
  return result;
}
