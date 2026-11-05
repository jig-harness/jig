/**
 * Show all and its way back. A list longer than two rows shows two, with the
 * toggle both in the panel's head and at the list's foot, so closing a long list
 * never needs a scroll to its end; closing from the foot brings the panel's head
 * back into view.
 */
import { type RefObject, useCallback, useRef, useState } from "react";

type Where = "head" | "foot";

/** Rows a closed list shows. */
export const SHOWN_CLOSED = 2;

export function useShowAll(): [
  boolean,
  (all: boolean, where: Where) => void,
  RefObject<HTMLElement | null>,
] {
  const [all, setAll] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  const change = useCallback((next: boolean, where: Where) => {
    setAll(next);
    const element = panel.current;
    if (!next && where === "foot" && element !== null)
      if (element.getBoundingClientRect().top < 0)
        element.scrollIntoView({ block: "start" });
  }, []);
  return [all, change, panel];
}

export function MoreToggle({
  count,
  all,
  setAll,
  where,
}: {
  count: number;
  all: boolean;
  setAll: (all: boolean, where: Where) => void;
  where: Where;
}) {
  if (count <= SHOWN_CLOSED) return null;
  return (
    <button
      className={where === "head" ? "moreBtn headMore" : "moreBtn"}
      type="button"
      aria-expanded={all}
      onClick={() => setAll(!all, where)}
    >
      {all ? "Show fewer" : `Show all ${count}`}
    </button>
  );
}
