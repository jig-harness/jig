/**
 * The page's keys: the key map, what each key does on the card it is pressed
 * on, and roving focus over the cards, so j and k move one focus between
 * them while Tab still walks every control.
 *
 * A card is any element carrying `data-card` (`cardAttrs`): its pull request,
 * its issue and its primary command ride on it as data, so the keys need
 * nothing from the view that drew it. No key fires inside a text field.
 */
import { type RefObject, useEffect, useRef } from "react";
import { announce, copyText } from "./copy.tsx";
import { VIEWS, type ViewId } from "./search.ts";

/** What the keys list, in Help and behind `?`. */
export const KEYS: ReadonlyArray<{ keys: string[]; does: string }> = [
  {
    keys: ["⌘K", "Ctrl-K"],
    does: "open the palette: go to a view, jump to #N or an item, run a card's command",
  },
  { keys: ["j", "k"], does: "next or previous card" },
  { keys: ["Enter", "o"], does: "expand or collapse the card" },
  { keys: ["p"], does: "open the card's pull request" },
  { keys: ["i"], does: "open the card's issue" },
  {
    keys: ["c"],
    does: "copy the card's command: the pinned merge command, the answer line, or its jig ask line",
  },
  {
    keys: ["g m", "g n", "g r", "g q", "g h"],
    does: "go to Merge, Needs you, Running, Queue or History",
  },
  { keys: ["/"], does: "filter the view" },
  { keys: ["?"], does: "list the keys" },
];

/** How long after `g` its second key is still read as one. */
const CHORD_MS = 1500;

/** What a key asks for, before the page knows which card it lands on. */
export type KeyAction =
  | { kind: "palette" }
  | { kind: "move"; by: 1 | -1 }
  | { kind: "toggle" }
  | { kind: "open"; what: "pr" | "issue" }
  | { kind: "copy" }
  | { kind: "chord" }
  | { kind: "view"; view: ViewId }
  | { kind: "filter" }
  | { kind: "help" };

export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** The view `g` and then `key` goes to; `null` for a key no view takes. */
function viewAfterG(key: string): ViewId | null {
  return VIEWS.find((v) => v.key === key)?.id ?? null;
}

/**
 * What a key press asks for, or `null` when the page leaves it to the
 * browser. `chord` is whether `g` was the key before, within its time.
 */
export function actionOf(press: KeyPress, chord: boolean): KeyAction | null {
  const { key } = press;
  if (
    (press.metaKey || press.ctrlKey) &&
    !press.altKey &&
    key.toLowerCase() === "k"
  )
    return { kind: "palette" };
  if (press.metaKey || press.ctrlKey || press.altKey) return null;
  if (chord) {
    const view = viewAfterG(key);
    return view === null ? null : { kind: "view", view };
  }
  switch (key) {
    case "j":
      return { kind: "move", by: 1 };
    case "k":
      return { kind: "move", by: -1 };
    case "Enter":
    case "o":
      return { kind: "toggle" };
    case "p":
      return { kind: "open", what: "pr" };
    case "i":
      return { kind: "open", what: "issue" };
    case "c":
      return { kind: "copy" };
    case "g":
      return { kind: "chord" };
    case "/":
      return { kind: "filter" };
    case "?":
      return { kind: "help" };
    default:
      return null;
  }
}

const NOT_TYPED = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "submit",
  "reset",
  "image",
]);

/** Whether an element takes typing, where every key is the person's text. */
export function isTextField(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return !NOT_TYPED.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/** A pull request's address, told from an issue's by its path. */
function isPullUrl(url: string): boolean {
  return /\/pull\/\d+/.test(url);
}

/** The attributes that make an element a card the keys reach. */
export function cardAttrs(card: {
  key: string;
  url: string | null;
  command: string | null;
}): Record<string, string> {
  const attrs: Record<string, string> = { "data-card": card.key };
  if (card.url !== null)
    attrs[isPullUrl(card.url) ? "data-pr" : "data-issue"] = card.url;
  if (card.command !== null) attrs["data-command"] = card.command;
  return attrs;
}

/** The cards a person can see, in the page's order. */
export function cardsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-card]")].filter(
    (card) => !card.hidden && card.getClientRects().length > 0,
  );
}

/** The card focus is in or on, else the one the roving focus rests on. */
function currentCard(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  const inside =
    active instanceof HTMLElement
      ? active.closest<HTMLElement>("[data-card]")
      : null;
  if (inside !== null && root.contains(inside)) return inside;
  return root.querySelector<HTMLElement>('[data-card][tabindex="0"]');
}

/** One card takes Tab, the rest only j and k: the card focus rests on, else the first. */
export function rove(root: HTMLElement, onto: HTMLElement | null = null): void {
  const all = [...root.querySelectorAll<HTMLElement>("[data-card]")];
  const visible = cardsIn(root);
  const resting =
    onto ??
    all.find((c) => c.tabIndex === 0 && visible.includes(c)) ??
    visible[0] ??
    null;
  for (const card of all) card.tabIndex = card === resting ? 0 : -1;
}

/** Focuses a card and makes it the one Tab rests on. */
export function focusCard(root: HTMLElement, card: HTMLElement): void {
  rove(root, card);
  card.focus();
  card.scrollIntoView({ block: "nearest" });
}

function move(root: HTMLElement, by: 1 | -1): void {
  const cards = cardsIn(root);
  if (cards.length === 0) {
    announce("No cards in this view");
    return;
  }
  const current = currentCard(root);
  const at = current === null ? -1 : cards.indexOf(current);
  // From outside a card, j and k land on the card focus last rested on.
  const onOne = document.activeElement?.closest("[data-card]") === current;
  const next =
    at === -1
      ? 0
      : onOne
        ? Math.min(cards.length - 1, Math.max(0, at + by))
        : at;
  const card = cards[next];
  if (card !== undefined) focusCard(root, card);
}

/** The card's own expand control: the one it names, else its first fold (a reply's button is not one). */
function toggleOf(card: HTMLElement): HTMLElement | null {
  return (
    card.querySelector<HTMLElement>("[data-card-toggle]") ??
    card.querySelector<HTMLElement>(".foldBtn.disclosure")
  );
}

function onCard(
  root: HTMLElement,
  action: KeyAction & { kind: "toggle" | "open" | "copy" },
  target: EventTarget | null,
): boolean {
  const card = currentCard(root);
  if (card === null) {
    announce("No card is chosen: press j first");
    return action.kind !== "toggle";
  }
  if (action.kind === "toggle") {
    // Enter on a control inside the card is that control's own.
    if (
      target instanceof HTMLElement &&
      target !== card &&
      target.closest("a, button, summary, [role='button']")
    )
      return false;
    const toggle = toggleOf(card);
    if (toggle === null) announce("This card has nothing more to show");
    else {
      toggle.click();
      card.focus();
    }
    return true;
  }
  if (action.kind === "open") {
    const url = action.what === "pr" ? card.dataset.pr : card.dataset.issue;
    if (url === undefined)
      announce(
        action.what === "pr"
          ? "This card has no pull request"
          : "This card has no issue",
      );
    else window.open(url, "_blank", "noopener,noreferrer");
    return true;
  }
  const command = card.dataset.command;
  if (command === undefined) announce("This card has no command to copy");
  else void copyText(command, card);
  return true;
}

export interface KeyHandlers {
  setView: (view: ViewId) => void;
  openPalette: () => void;
  /** Whether a dialog of the page's own has the keys. */
  paletteOpen: () => boolean;
  focusFilter: () => void;
}

/** Installs the page's keys on the document, over the cards under `root`. */
export function useKeys(
  root: RefObject<HTMLElement | null>,
  handlers: KeyHandlers,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    let chordAt = Number.NEGATIVE_INFINITY;
    const listen = (event: KeyboardEvent) => {
      const element = root.current;
      const h = latest.current;
      if (element === null || h.paletteOpen() || event.defaultPrevented) return;
      if (isTextField(event.target instanceof Element ? event.target : null))
        return;
      const chord = performance.now() - chordAt < CHORD_MS;
      chordAt = Number.NEGATIVE_INFINITY;
      const action = actionOf(event, chord);
      if (action === null) return;
      let handled = true;
      switch (action.kind) {
        case "palette":
          h.openPalette();
          break;
        case "move":
          move(element, action.by);
          break;
        case "chord":
          chordAt = performance.now();
          break;
        case "view":
          h.setView(action.view);
          break;
        case "filter":
          h.focusFilter();
          break;
        case "help":
          h.setView("help");
          break;
        default:
          handled = onCard(element, action, event.target);
      }
      if (handled) event.preventDefault();
    };
    document.addEventListener("keydown", listen);
    return () => document.removeEventListener("keydown", listen);
  }, [root]);
  // Cards come and go with every read, so the one Tab rests on is kept current as they do.
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    rove(element);
    const watcher = new MutationObserver(() => rove(element));
    watcher.observe(element, { childList: true, subtree: true });
    return () => watcher.disconnect();
  }, [root]);
}
