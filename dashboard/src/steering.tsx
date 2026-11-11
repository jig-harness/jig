/**
 * How a person steers the page without the pointer: the keys over the cards,
 * the palette, the filter over a view's cards, and the focus a view change
 * hands to the card or heading it was for.
 */
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { keptCommit } from "./answers.ts";
import { allCards, type CardInfo } from "./cards.ts";
import { announce, copyText } from "./copy.tsx";
import {
  CARD_COMMIT,
  cardsIn,
  focusCard,
  focusStart,
  rove,
  useKeys,
} from "./keys.ts";
import {
  type PaletteEntry,
  type PaletteRun,
  paletteEntries,
} from "./palette.tsx";
import type { ViewId } from "./search.ts";
import type { Clock } from "./view.ts";

/** Where `?` and the palette's Help land: the keys. */
const KEYS_HEADING = "#h-keys";

/** A pending focus that asks for where the new view starts. */
const START = "start";

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
          const main = event.currentTarget.closest<HTMLElement>("main");
          if (main !== null) focusStart(main);
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
  // While a query stands, the cards a phone keeps behind Show all are searched and shown too.
  element.classList.toggle("filtering", words.length > 0);
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
  return (
    [...element.querySelectorAll<HTMLElement>("[data-card]")].find(
      (c) => c.dataset.card === key,
    ) ?? null
  );
}

/** Opens the view's Show all when it holds the card; whether it was opened, for the commit it schedules to draw the card. */
function reveal(element: HTMLElement, target: HTMLElement): boolean {
  if (target.closest(".rest") === null) return false;
  const more = element.querySelector<HTMLButtonElement>(
    ".moreBtn[aria-expanded='false']",
  );
  if (more === null) return false;
  more.click();
  return true;
}

const BEHIND_SHOW_ALL = "That card is behind Show all in this view";

/** Focuses a card once Show all has drawn it, in the frame after the click; a card still hidden is said. */
function focusRevealed(element: HTMLElement, key: string): void {
  requestAnimationFrame(() => {
    const target = pendingTarget(element, key);
    if (target !== null && cardsIn(element).includes(target))
      focusCard(element, target);
    else {
      focusStart(element);
      announce(BEHIND_SHOW_ALL);
    }
  });
}

/** Moves focus to what a pending request names, once; a card it cannot show is said, not kept for later. */
function focusPending(element: HTMLElement, pending: string): void {
  if (pending === START) {
    focusStart(element);
    return;
  }
  const target = pendingTarget(element, pending);
  if (target === null) focusStart(element);
  else if (target.dataset.card === undefined) target.focus();
  else if (cardsIn(element).includes(target)) focusCard(element, target);
  else if (reveal(element, target)) focusRevealed(element, pending);
  else {
    focusStart(element);
    announce(BEHIND_SHOW_ALL);
  }
}

/** Copies a card's command through the card itself, which may take a second step or hold it back; as the command alone where the card does not. */
function commitOn(element: HTMLElement, card: CardInfo): void {
  const commit = new CustomEvent(CARD_COMMIT, { cancelable: true });
  if (element.dispatchEvent(commit) && card.command !== null)
    void copyText(card.command, element);
}

/** Copies through `card` once focus has reached it, a frame or two after the view drew it. */
function commitOnceFocused(root: HTMLElement, card: CardInfo): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const target = pendingTarget(root, card.key);
      if (target !== null && document.activeElement === target)
        commitOn(target, card);
    }),
  );
}

/** Focuses what a view change was for, in the commit that drew the view, and then forgets it; a copy that waited for the card runs there. */
function useFocusAfterDraw(
  root: RefObject<HTMLElement | null>,
  pending: string | null,
  settle: () => void,
  commitAfter: RefObject<CardInfo | null>,
): void {
  useEffect(() => {
    const element = root.current;
    if (pending === null || element === null) return;
    settle();
    focusPending(element, pending);
    const card = commitAfter.current;
    commitAfter.current = null;
    if (card !== null && card.key === pending) commitOnceFocused(element, card);
  }, [root, pending, settle, commitAfter]);
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
  /** Goes to a view and puts focus where it starts, for a control that the change removes. */
  goAndFocus: (view: ViewId) => void;
  /** Puts focus where the view starts, for a control that removes itself. */
  focusStart: () => void;
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
  const settle = useCallback(() => setPending(null), []);
  const commitAfter = useRef<CardInfo | null>(null);
  useFocusAfterDraw(main, pending, settle, commitAfter);
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
  const goFocused = (view: ViewId, focus: string) => {
    go(view);
    setPending(view === "help" ? KEYS_HEADING : focus);
  };
  useKeys(main, {
    setView: (view) => goFocused(view, START),
    openPalette: () => {
      setBack(activeElement());
      setEntries(
        paletteEntries(
          allCards(o.line, o.clock, (need) =>
            keptCommit(need.repo, need.target, need.rows),
          ),
          o.counts,
        ),
      );
    },
    paletteOpen: () => entries !== null,
    focusFilter: () => focusFilter(main.current),
  });
  const runPalette = (run: PaletteRun) => {
    if (run.kind !== "copy") {
      goFocused(
        run.kind === "view" ? run.view : run.card.view,
        run.kind === "card" ? run.card.key : START,
      );
      return;
    }
    const card = run.card;
    if (card.committedOnCard === true) {
      // Its second step, or why it is held back, is on the card, so the copy runs there.
      const element = main.current;
      const target =
        element === null ? null : pendingTarget(element, `${card.key}`);
      if (
        element !== null &&
        target !== null &&
        cardsIn(element).includes(target)
      ) {
        focusCard(element, target);
        commitOn(target, card);
      } else {
        commitAfter.current = card;
        goFocused(card.view, card.key);
      }
      return;
    }
    const to = back ?? main.current;
    if (card.command !== null && to !== null) void copyText(card.command, to);
  };
  const closePalette = () => {
    setEntries(null);
    const to = back ?? main.current;
    if (to?.isConnected) to.focus();
  };
  return {
    go,
    goAndFocus: (view) => goFocused(view, START),
    focusStart: () => setPending(START),
    cardQuery,
    setCardQuery,
    shown,
    entries,
    runPalette,
    closePalette,
  };
}
