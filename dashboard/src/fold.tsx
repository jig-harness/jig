/**
 * The page's disclosures and its term popovers.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { Popover } from "@base-ui/react/popover";
import { createContext, type ReactNode, useContext, useState } from "react";
import { CopyButton } from "./copy.tsx";
import type { EvidenceRow } from "./view.ts";

/** The element popups render into, so they keep the page's tokens and width rules. */
export const PopupRoot = createContext<HTMLElement | null>(null);

export function Fold({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root className="fold">
      <Collapsible.Trigger className="foldBtn">{label}</Collapsible.Trigger>
      <Collapsible.Panel>{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Evidence as the record gives it, each value with a Copy where it is worth taking. */
export function Evidence({ rows }: { rows: EvidenceRow[] }) {
  return (
    <dl className="kv">
      {rows.map((row) => (
        <div key={`${row.k} ${row.v}`} style={{ display: "contents" }}>
          <dt>{row.k}</dt>
          <dd className="m">
            <span>{row.v}</span>
            {row.copy === undefined ? null : (
              <CopyButton text={row.copy} aria={`Copy ${row.k}`} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A row of small squares, one per slot or night; a filled one is held or occurred. */
export function Pips({ on }: { on: boolean[] }) {
  return on
    .map((filled, place) => ({ filled, place: `place ${place}` }))
    .map((pip) => (
      <span className={pip.filled ? "pip on" : "pip"} key={pip.place} />
    ));
}

/** A term and what it means, opened by a tap, a click or keyboard focus; hover alone reveals nothing. */
export function Term({
  word,
  children,
}: {
  word: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useContext(PopupRoot);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="termBtn"
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
      >
        {word}
      </Popover.Trigger>
      <Popover.Portal container={root}>
        <Popover.Positioner
          className="popPos"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          <Popover.Popup
            className="pop"
            aria-label={word}
            initialFocus={false}
            finalFocus={false}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
