/**
 * Merge: Ready to merge's three lanes, merge now first, each card with the
 * command a person copies, and the flash every other view shows while merge
 * now holds a pull request.
 */
import { useState } from "react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { cardAttrs } from "./keys.ts";
import { mergeCard } from "./cards.ts";
import { CopyButton } from "./copy.tsx";
import { Fold, PanelHelp } from "./fold.tsx";
import { Glyph } from "./icon-word.tsx";
import { iconOf, LANE_ICONS } from "./icons.ts";
import { readKept, writeKept } from "./kept.ts";
import {
  boardNotes,
  type FlashView,
  flashOf,
  keepDismissed,
  type MergeCardView,
  mergeLanes,
} from "./merge-view.ts";
import { Pr, RepoLink } from "./pr.tsx";
import type { Clock } from "./view.ts";

function MergeItem({ card }: { card: MergeCardView }) {
  const info = mergeCard(card);
  return (
    <article className="need mCard" {...cardAttrs(info)}>
      <div className="rowTop">
        <Pr repo={card.repo} target={card.target} url={card.url} />
        <span className="m sm mut end nowrap">ready {card.age}</span>
        <span className="br" />
        <RepoLink repo={card.repo} url={card.url} />
        {card.act === null ? null : <span className="chip">{card.act}</span>}
      </div>
      <q className="sm mTitle">{card.title}</q>
      <p className="sm mut">{card.says}</p>
      {card.failing.length === 0 ? null : (
        <p className="sm">Failing: {card.failing.join(", ")}.</p>
      )}
      {card.unblocks.length === 0 ? null : (
        <p className="sm">
          Unblocks {card.unblocks.map((n) => `#${n}`).join(", ")}.
        </p>
      )}
      <div className="goto">
        <span className="m sm mCommand">{card.command}</span>
        <CopyButton
          text={card.command}
          idle={card.merges ? "Copy merge command" : "Copy jig ask line"}
          aria={`Copy the ${info.commandLabel} for ${card.target}`}
        />
        {card.withheld === null ? null : (
          <span className="noLink">
            Merge command withheld: {card.withheld} does not pass its form.
          </span>
        )}
        <Fold label={`Ready conditions for ${card.target}`}>
          <ul className="mConds sm">
            {card.conditions.map((c) => (
              <li key={c.name}>
                <span className="m" aria-hidden="true">
                  {c.met === true ? "✓" : c.met === false ? "✗" : "?"}
                </span>{" "}
                <b>{c.name}</b>
                {c.met === null ? " (not read)" : c.met ? "" : " (not met)"}:{" "}
                {c.fact}
              </li>
            ))}
          </ul>
        </Fold>
      </div>
    </article>
  );
}

export function MergePanel({
  line,
  clock,
}: {
  line: LineSnapshot | null;
  clock: Clock;
}) {
  const lanes = mergeLanes(line, clock.nowMs);
  const notes = boardNotes(line);
  return (
    <section className="panel pMerge" aria-labelledby="h-merge">
      <div className="panelHead">
        <h2 id="h-merge">Ready to merge</h2>
        <PanelHelp panel="Ready to merge">
          Converged pull requests, grouped by the next act they ask. Only merge
          now is safe to merge: its command is pinned to the head the drive
          verified, so a newer head refuses it. Approve first waits on an
          approval; update next on an up-to-date branch.
        </PanelHelp>
      </div>
      {lanes.length > 0 ? null : (
        <p className="emptyLine">
          {line === null
            ? "Nothing to merge: no tick has read the forge."
            : "Nothing is ready to merge. A converged pull request appears here once the board read places it."}
        </p>
      )}
      <div className="needList all">
        {lanes.map((lane, i) => (
          <div className="mLane" key={lane.lane}>
            <div className={`groupHead${i === 0 ? " first" : ""}`}>
              <span className="headWord">
                <Glyph of={iconOf(LANE_ICONS, lane.lane)} size={16} />
                {lane.title} · {lane.cards.length}
              </span>
            </div>
            <p className="sm mut gnote">{lane.note}</p>
            {lane.cards.map((card) => (
              <MergeItem card={card} key={card.rowKey} />
            ))}
          </div>
        ))}
      </div>
      {notes.length === 0 ? null : (
        <ul className="sm mut mNotes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

const DISMISSED = "merge-flash-dismissed";

function readDismissed(): Set<string> {
  const kept = readKept(DISMISSED);
  if (kept === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(kept);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((k): k is string => typeof k === "string")
        : [],
    );
  } catch (cause) {
    // A value this browser kept that no longer parses dismisses nothing.
    if (!(cause instanceof SyntaxError)) throw cause;
    return new Set();
  }
}

/** The flash's state: what it says now, and how to dismiss it until merge now holds a new head. */
export function useFlash(
  line: LineSnapshot | null,
): [FlashView | null, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  const flash = flashOf(line, dismissed);
  const dismiss = () => {
    if (flash === null) return;
    // Heads that left merge now stay dismissed while they come back unchanged, up to a bound;
    // the bound trims only heads no longer in merge now, so every current head is dismissed.
    const next = keepDismissed(dismissed, flash.keys);
    setDismissed(next);
    writeKept(DISMISSED, JSON.stringify([...next]));
  };
  return [flash, dismiss];
}

export function MergeFlash({
  flash,
  onGo,
  onDismiss,
  href,
}: {
  flash: FlashView;
  onGo: () => void;
  onDismiss: () => void;
  href: string;
}) {
  return (
    <section className="flash" role="status" aria-label="Safe to merge">
      <span className="mk r-working" aria-hidden="true">
        ✓
      </span>
      <p className="flashText">{flash.text}</p>
      <a
        className="flashGo"
        href={href}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onGo();
        }}
      >
        Go to Merge <kbd>g</kbd> <kbd>m</kbd>
      </a>
      <button className="flashOff" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}
