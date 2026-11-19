/**
 * The card with gutter, the page's one disclosure: a bare chevron in a fixed
 * left gutter, so it sits in one place on every card of a view whatever the
 * text after it. A click or tap anywhere else on the card opens and closes it
 * too, unless it lands on a link, a button or a field, ends a text selection,
 * or moved on the way (a scroll or a drag). Enter and o reach the same chevron
 * through `data-card-toggle` (`keys.ts`). A heading that folds what follows it,
 * such as the load's holds and reservations or the accounts list, uses the
 * same gutter and chevron (`GutterFold`).
 */
import {
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useId,
  useRef,
  useState,
} from "react";
import { Glyph } from "./icon-word.tsx";
import { CONTROL_ICONS } from "./icons.ts";

/** What takes its own click inside a card: controls, fields, and the opened detail, which a person reads and selects in. */
const OWN_CLICK =
  "a, button, input, select, textarea, label, summary, [role='button'], [role='option'], [role='combobox'], [data-no-toggle]";

/** How far a pointer may move between press and release and still count as a tap. */
const TAP_SLOP_PX = 8;

/** Whether the person has text selected inside `area`. */
function selectingIn(area: Element): boolean {
  const selection = window.getSelection();
  if (selection === null || selection.toString().trim() === "") return false;
  return [selection.anchorNode, selection.focusNode].some(
    (node) => node !== null && area.contains(node),
  );
}

/** Whether a click landed on the area's own space: not a control of its own, nor a popup it opened, which reaches it through the component tree. */
function onOwnSpace(area: Element, target: EventTarget): boolean {
  if (!(target instanceof Element) || !area.contains(target)) return false;
  const own = target.closest(OWN_CLICK);
  return own === null || !area.contains(own);
}

type Point = { x: number; y: number };

/** Where a pointer or mouse event happened. */
function point(event: { clientX: number; clientY: number }): Point {
  return { x: event.clientX, y: event.clientY };
}

/** Whether the pointer is farther from where it was pressed than a tap's slop. */
function beyondSlop(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > TAP_SLOP_PX;
}

/** What one press-to-release gesture has done so far. */
interface Gesture {
  from: Point | null;
  dragged: boolean;
  /** Whether the click before this one toggled. */
  toggled: boolean;
}

/** Ends the gesture at `to`: whether the pointer left the tap's slop at any point of it. */
function wasDrag(gesture: Gesture, to: Point): boolean {
  const { from, dragged } = gesture;
  gesture.from = null;
  gesture.dragged = false;
  return dragged || (from !== null && beyondSlop(from, to));
}

/** Whether a click is a later one of a double or triple click, which selects text: the first click's toggle is undone, so the card keeps its state. */
function repeatedClick(
  gesture: Gesture,
  detail: number,
  toggle: () => void,
): boolean {
  const first = gesture.toggled;
  gesture.toggled = false;
  if (detail <= 1) return false;
  if (detail === 2 && first) toggle();
  return true;
}

/** The handlers that let a whole area toggle, the area's own controls aside. */
export function useTapToggle(toggle: (() => void) | null) {
  const gesture = useRef<Gesture>({
    from: null,
    dragged: false,
    toggled: false,
  });
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      gesture.current.from = { x: event.clientX, y: event.clientY };
      gesture.current.dragged = false;
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const { from } = gesture.current;
      if (from !== null && beyondSlop(from, point(event)))
        gesture.current.dragged = true;
    },
    onPointerCancel: () => {
      gesture.current.from = null;
      gesture.current.dragged = false;
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const drag = wasDrag(gesture.current, point(event));
      if (toggle === null || event.defaultPrevented) return;
      if (repeatedClick(gesture.current, event.detail, toggle)) return;
      const area = event.currentTarget;
      if (!onOwnSpace(area, event.target) || selectingIn(area) || drag) return;
      gesture.current.toggled = true;
      toggle();
    },
  };
}

/** The bare chevron: a real button, so a screen reader hears its name and whether it is open, not the card's whole text. */
export function Disc({
  open,
  label,
  controls,
  onToggle,
  card = false,
}: {
  open: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
  /** Whether it opens a card, which Enter and o reach it through. */
  card?: boolean;
}) {
  return (
    <button
      type="button"
      className="disc"
      data-card-toggle={card ? "" : undefined}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      aria-keyshortcuts={card ? undefined : "O"}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (
          card ||
          event.key !== "o" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        event.preventDefault();
        if (!event.repeat) onToggle();
      }}
    >
      <Glyph of={CONTROL_ICONS.disclosure} size={16} />
    </button>
  );
}

/** A card: its face always, its detail while open; `detail` null keeps the gutter empty, so its face still lines up. */
export function GutterCard({
  className,
  attrs,
  label,
  face,
  detail,
  cardRef,
  onBlur,
}: {
  className: string;
  /** What makes it a card the keys reach (`cardAttrs`). */
  attrs: Record<string, string>;
  /** The chevron's name: what opening it shows. */
  label: string;
  face: ReactNode;
  detail: ReactNode | null;
  cardRef?: Ref<HTMLElement>;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = detail === null ? null : () => setOpen((was) => !was);
  const tap = useTapToggle(toggle);
  const shown = open && detail !== null;
  return (
    <article
      className={`card ${className}${shown ? " open" : ""}${toggle === null ? "" : " opens"}`}
      {...attrs}
      ref={cardRef}
      onBlur={onBlur}
      {...tap}
    >
      <div className="gutter">
        {toggle === null ? null : (
          <Disc
            open={shown}
            label={label}
            controls={id}
            onToggle={toggle}
            card
          />
        )}
        {shown ? <span className="spine" aria-hidden="true" /> : null}
      </div>
      <div className="cbody">
        {face}
        {shown ? (
          <div className="detail" id={id} data-no-toggle="">
            {detail}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** A heading that folds what follows it, on the same gutter as the cards: the chevron, or a tap anywhere on the heading. */
export function GutterFold({
  className,
  label,
  head,
  children,
  defaultOpen = false,
  keepMounted = false,
  resetKey,
}: {
  className?: string;
  /** The chevron's name. */
  label: string;
  head: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Keep the folded content in the document, so filters can still read it. */
  keepMounted?: boolean;
  /** When it changes, a person's choice is dropped and the default applies again; the content stays mounted. */
  resetKey?: string;
}) {
  const [chosenOpen, setOpen] = useState<boolean | null>(null);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setOpen(null);
  }
  const open = chosenOpen ?? defaultOpen;
  const id = useId();
  const toggle = () => setOpen((was) => !(was ?? defaultOpen));
  const tap = useTapToggle(toggle);
  return (
    <div
      className={`gfold${className === undefined ? "" : ` ${className}`}${open ? " open" : ""}`}
    >
      <div className="ghead" {...tap}>
        <div className="gutter">
          <Disc open={open} label={label} controls={id} onToggle={toggle} />
        </div>
        <div className="gheadBody">{head}</div>
      </div>
      {open || keepMounted ? (
        <div className="gpanel" id={id} hidden={!open}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
