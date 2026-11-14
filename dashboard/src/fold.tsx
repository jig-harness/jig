/**
 * The page's disclosures and its hints: popovers that say what a word, a chip
 * or a panel means.
 */
import { Collapsible } from "@base-ui/react/collapsible";
import { Popover } from "@base-ui/react/popover";
import { createContext, type ReactNode, useContext, useState } from "react";
import { CopyButton } from "./copy.tsx";
import { Glyph, SourceChip, StageChip } from "./icon-word.tsx";
import { CONTROL_ICONS } from "./icons.ts";
import { sourceMeaning, stageMeaning } from "./status.ts";
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
      <Collapsible.Trigger
        className="foldBtn disclosure"
        aria-label={label}
        title={label}
      >
        <Glyph of={CONTROL_ICONS.disclosure} size={16} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="foldPanel">{children}</Collapsible.Panel>
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
            {/^https?:\/\//.test(row.v) ? (
              <a href={row.v} target="_blank" rel="noreferrer noopener">
                {row.v}
              </a>
            ) : (
              <span>{row.v}</span>
            )}
            {row.copy === undefined || /^https?:\/\//.test(row.v) ? null : (
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

/** How long a pointer rests on a hint before it opens, and stays away before it closes. */
const HOVER_OPEN_MS = 200;
const HOVER_CLOSE_MS = 150;

/**
 * A hint: a trigger and what it means, opened by hovering, a tap, a click or
 * keyboard focus, so a phone with no hover reaches it too.
 */
export function Hint({
  label,
  className,
  trigger,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  /** The popup's accessible name, and the trigger's when `trigger` is not text. */
  label: string;
  className: string;
  trigger: ReactNode;
  children: ReactNode;
  /** Set both to let the caller open the hint from somewhere beyond the trigger, such as a hovered row. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const root = useContext(PopupRoot);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={className}
        openOnHover
        delay={HOVER_OPEN_MS}
        closeDelay={HOVER_CLOSE_MS}
        aria-label={typeof trigger === "string" ? undefined : label}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
      >
        {trigger}
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
            aria-label={label}
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

/** A term and what it means. */
export function Term({
  word,
  children,
}: {
  word: string;
  children: ReactNode;
}) {
  return (
    <Hint className="termBtn" label={word} trigger={word}>
      {children}
    </Hint>
  );
}

/** A stage's chip, which says what the stage does. */
export function StageHint({ stage }: { stage: string }) {
  return (
    <Hint
      className="chipBtn"
      label={`Stage ${stage}`}
      trigger={<StageChip stage={stage} />}
    >
      <b>{stage}</b>: {stageMeaning(stage)}
    </Hint>
  );
}

/** A queued target's source chip, which says where it came from. */
export function SourceHint({ source }: { source: string }) {
  return (
    <Hint
      className="chipBtn"
      label={`Source ${source}`}
      trigger={<SourceChip source={source} />}
    >
      <b>{source}</b>: {sourceMeaning(source)}
    </Hint>
  );
}

/** The `?` beside a panel's heading: what the panel shows and how to read it. */
export function PanelHelp({
  panel,
  children,
}: {
  panel: string;
  children: ReactNode;
}) {
  return (
    <Hint
      className="helpBtn"
      label={`About ${panel}`}
      trigger={<span aria-hidden="true">?</span>}
    >
      {children}
    </Hint>
  );
}
