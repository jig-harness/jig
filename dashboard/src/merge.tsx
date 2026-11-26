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
import { BoardCardLead, BoardStatus } from "./board-status.tsx";
import { PanelHelp } from "./fold.tsx";
import { GutterCard } from "./gutter.tsx";
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
import { LinkedDetail } from "./work.tsx";
import type { Clock } from "./view.ts";

/** The Ready conditions checklist folded inside both Merge and Needs-you board cards. */
export function ReadyConditions({
  conditions,
}: {
  conditions: MergeCardView["conditions"];
}) {
  return (
    <>
      <h3 className="sm">Ready conditions</h3>
      <ul className="mConds sm">
        {conditions.map((c) => (
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
    </>
  );
}

function MergeItem({ card }: { card: MergeCardView }) {
  const info = mergeCard(card);
  return (
    <GutterCard
      className="need mCard"
      attrs={cardAttrs(info)}
      label={`Ready conditions for ${card.target}`}
      face={
        <>
          <BoardCardLead
            repo={card.repo}
            target={card.target}
            url={card.url}
            title={card.title}
            links={card.links}
            age={`ready ${card.age}`}
            action={card.act}
          />
          <q className="sm mTitle">{card.title}</q>
          <p className="sm mut">{card.says}</p>
          <BoardStatus failing={card.failing} unblocks={card.unblocks} />
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
          </div>
        </>
      }
      detail={
        <>
          <ReadyConditions conditions={card.conditions} />
          <LinkedDetail
            repo={card.repo}
            target={card.target}
            links={card.links}
          />
        </>
      }
    />
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
            <div className={`groupHead groupWord${i === 0 ? " first" : ""}`}>
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
