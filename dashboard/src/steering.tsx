/**
 * How a person steers the page without the pointer: the keys over the cards,
 * the palette, the filter over a view's cards, and the focus a view change
 * hands to the card or heading it was for.
 */
import { type RefObject, useCallback, useEffect, useState } from "react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { allCards } from "./cards.ts";
import { announce, copyText } from "./copy.tsx";
import { cardsIn, focusCard, rove, useKeys } from "./keys.ts";
import {
  type PaletteEntry,
  type PaletteRun,
  paletteEntries,
} from "./palette.tsx";
import type { ViewId } from "./search.ts";
import type { Clock } from "./view.ts";

/** Where `?` and the palette's Help land: the keys. */
const KEYS_HEADING = "#h-keys";

/** The filter over a view's cards, which `/` focuses and Escape clears. */
export function ViewFilter({
  value,
  setValue,
  shown,
}: {
  value: string;
  setValue: (value: string) => void;
  shown: string | null;
}) {
  return (
    <div className="viewFilter">
      <input
        type="search"
        data-view-filter=""
        aria-label="Filter this view's cards"
        placeholder="Filter this view  /"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setValue("");
          event.currentTarget.blur();
        }}
      />
      {shown === null ? null : <span className="sm mut">{shown}</span>}
    </div>
  );
}

/** Hides each card whose text lacks a word of the query; how many cards it keeps. */
function applyFilter(element: HTMLElement, query: string): string | null {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  const cards = [...element.querySelectorAll<HTMLElement>("[data-card]")];
  for (const card of cards) {
    const text = card.textContent?.toLowerCase() ?? "";
    const hide = !words.every((w) => text.includes(w));
    if (card.hidden !== hide) card.hidden = hide;
  }
  rove(element);
  if (words.length === 0) return null;
  return `${cards.filter((c) => !c.hidden).length} of ${cards.length} cards`;
}

/** Keeps the filter applied as cards come and go with each read. */
function useCardFilter(
  root: RefObject<HTMLElement | null>,
  query: string,
): string | null {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const apply = () => setShown(applyFilter(element, query));
    apply();
    const watcher = new MutationObserver(apply);
    watcher.observe(element, { childList: true, subtree: true });
    return () => watcher.disconnect();
  }, [root, query]);
  return shown;
}

/** The element a pending focus names: a card by its key, or a heading by its selector. */
function pendingTarget(element: HTMLElement, key: string): HTMLElement | null {
  if (key.startsWith("#")) return element.querySelector<HTMLElement>(key);
  return cardsIn(element).find((c) => c.dataset.card === key) ?? null;
}

/** Focuses what a view change was for, once the view has drawn it. */
function useFocusAfterDraw(
  root: RefObject<HTMLElement | null>,
  pending: string | null,
  settle: () => void,
): void {
  useEffect(() => {
    const element = root.current;
    if (pending === null || element === null) return;
    const target = pendingTarget(element, pending);
    if (target === null) return;
    settle();
    if (target.dataset.card === undefined) target.focus();
    else focusCard(element, target);
  });
}

function focusFilter(element: HTMLElement | null): void {
  const field = element?.querySelector<HTMLInputElement>(
    '[data-view-filter], .fields input[type="search"]',
  );
  if (field == null) announce("This view has no filter");
  else field.focus();
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

export interface Steering {
  /** Goes to a view, as a tab does: its filter cleared. */
  go: (view: ViewId) => void;
  cardQuery: string;
  setCardQuery: (query: string) => void;
  shown: string | null;
  /** The palette's entries while it is open, `null` while it is closed. */
  entries: PaletteEntry[] | null;
  runPalette: (run: PaletteRun) => void;
  closePalette: () => void;
}

/** The keys, the palette and the view's filter, over the cards under `main`. */
export function useSteering(
  main: RefObject<HTMLElement | null>,
  o: {
    line: LineSnapshot | null;
    clock: Clock;
    counts: Partial<Record<ViewId, number>>;
    setView: (view: ViewId) => void;
  },
): Steering {
  const { setView } = o;
  const [cardQuery, setCardQuery] = useState("");
  const shown = useCardFilter(main, cardQuery);
  const [pending, setPending] = useState<string | null>(null);
  useFocusAfterDraw(main, pending, () => setPending(null));
  // Read once as the palette opens, so a read while it is open does not move its list.
  const [entries, setEntries] = useState<PaletteEntry[] | null>(null);
  const [back, setBack] = useState<HTMLElement | null>(null);
  const go = useCallback(
    (view: ViewId) => {
      setCardQuery("");
      setView(view);
    },
    [setView],
  );
  const goFocused = (view: ViewId, focus: string | null) => {
    go(view);
    setPending(view === "help" ? KEYS_HEADING : focus);
  };
  useKeys(main, {
    setView: (view) => goFocused(view, null),
    openPalette: () => {
      setBack(activeElement());
      setEntries(paletteEntries(allCards(o.line, o.clock), o.counts));
    },
    paletteOpen: () => entries !== null,
    focusFilter: () => focusFilter(main.current),
  });
  const runPalette = (run: PaletteRun) => {
    if (run.kind !== "copy") {
      goFocused(
        run.kind === "view" ? run.view : run.card.view,
        run.kind === "card" ? run.card.key : null,
      );
      return;
    }
    const to = back ?? main.current;
    if (run.card.command !== null && to !== null)
      void copyText(run.card.command, to);
  };
  const closePalette = () => {
    setEntries(null);
    const to = back ?? main.current;
    if (to?.isConnected) to.focus();
  };
  return {
    go,
    cardQuery,
    setCardQuery,
    shown,
    entries,
    runPalette,
    closePalette,
  };
}
