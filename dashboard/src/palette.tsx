/**
 * The palette ⌘K or Ctrl-K opens: one field over every view, every card and
 * every card's command, narrowed as a person types. It is a dialog whose
 * field keeps focus and names the chosen option as its active descendant,
 * so a screen reader follows the arrows without focus leaving the field.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CardInfo } from "./cards.ts";
import { VIEWS, type ViewId } from "./search.ts";

export type PaletteRun =
  | { kind: "view"; view: ViewId }
  | { kind: "card"; card: CardInfo }
  | { kind: "copy"; card: CardInfo };

export interface PaletteEntry {
  id: string;
  label: string;
  /** What the entry is, beside its label. */
  kind: string;
  /** The words a query matches beyond the label. */
  words: string;
  run: PaletteRun;
}

/** The most entries the list shows at once; typing narrows the rest. */
const SHOWN = 40;

const VIEW_LABEL = Object.fromEntries(
  VIEWS.map((v) => [v.id, v.label]),
) as Record<ViewId, string>;

/** The palette's entries: the views, then each card, then each card's command. */
export function paletteEntries(
  cards: CardInfo[],
  counts: Partial<Record<ViewId, number>>,
): PaletteEntry[] {
  const views = VIEWS.map(
    (v): PaletteEntry => ({
      id: `view ${v.id}`,
      label: `Go to ${v.label}${counts[v.id] === undefined ? "" : ` (${counts[v.id]})`}`,
      kind: "view",
      words: v.id,
      run: { kind: "view", view: v.id },
    }),
  );
  const jumps = cards.map(
    (c): PaletteEntry => ({
      id: `card ${c.key}`,
      label: `${c.target}${c.title === null ? "" : ` ${c.title}`}`,
      kind: VIEW_LABEL[c.view],
      words: c.repo,
      run: { kind: "card", card: c },
    }),
  );
  const commands = cards.flatMap((c): PaletteEntry[] =>
    c.command === null
      ? []
      : [
          {
            id: `copy ${c.key}`,
            label: `Copy the ${c.commandLabel} for ${c.target}`,
            kind: "command",
            words: `${c.repo} ${c.command}`,
            run: { kind: "copy", card: c },
          },
        ],
  );
  return [...views, ...jumps, ...commands];
}

/** The entries a query keeps: every word in it found in the entry; `#N` itself first, before `#N…`. */
export function matching(
  entries: PaletteEntry[],
  query: string,
): PaletteEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return entries;
  const kept = entries.filter((e) => {
    const text = `${e.label} ${e.words}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const number = words.find((w) => /^#\d+$/.test(w));
  if (number === undefined) return kept;
  const exact = new RegExp(`${number}(?!\\d)`);
  const first = kept.filter((e) => exact.test(e.label));
  return [...first, ...kept.filter((e) => !first.includes(e))];
}

export function Palette({
  entries,
  onRun,
  onClose,
}: {
  entries: PaletteEntry[];
  onRun: (run: PaletteRun) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const field = useRef<HTMLInputElement | null>(null);
  const id = useId();
  const shown = useMemo(
    () => matching(entries, query).slice(0, SHOWN),
    [entries, query],
  );
  const chosen = Math.min(at, Math.max(0, shown.length - 1));
  useEffect(() => {
    field.current?.focus();
  }, []);
  useEffect(() => {
    document
      .getElementById(`${id}-${chosen}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [id, chosen]);
  const run = (entry: PaletteEntry | undefined) => {
    if (entry === undefined) return;
    onClose();
    onRun(entry.run);
  };
  return (
    <div className="paletteBack">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={field}
          className="paletteField"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            shown.length === 0 ? undefined : `${id}-${chosen}`
          }
          aria-label="Go to a view, #N or an item, or a card's command"
          placeholder="Go to a view, #N or an item, or a command"
          value={query}
          onBlur={onClose}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setAt(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              setAt(Math.min(chosen + 1, shown.length - 1));
              event.preventDefault();
            } else if (event.key === "ArrowUp") {
              setAt(Math.max(chosen - 1, 0));
              event.preventDefault();
            } else if (event.key === "Enter") {
              run(shown[chosen]);
              event.preventDefault();
            } else if (event.key === "Escape" || event.key === "Tab") {
              onClose();
              event.preventDefault();
            }
          }}
        />
        <div
          className="paletteList"
          id={`${id}-list`}
          role="listbox"
          aria-label="Matches"
        >
          {shown.map((entry, i) => (
            <div
              key={entry.id}
              id={`${id}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === chosen}
              className={i === chosen ? "paletteOpt on" : "paletteOpt"}
              onMouseMove={() => setAt(i)}
              onMouseDown={(event) => {
                event.preventDefault();
                run(entry);
              }}
            >
              <span className="paletteLabel">{entry.label}</span>
              <span className="chip">{entry.kind}</span>
            </div>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="sm mut paletteNone">Nothing matches.</p>
        ) : null}
      </div>
    </div>
  );
}
