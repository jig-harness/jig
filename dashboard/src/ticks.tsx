/**
 * How the ticks ran: one compact row per recent tick, the newest first, with
 * its length, its own phases as a bar scaled to the longest tick shown, the
 * slowest single phase named, the forge budget it read, and a chip for each
 * thing that went wrong. Each row opens to its phases and its repositories.
 */
import { useState } from "react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { Fold, Hint, PanelHelp } from "./fold.tsx";
import { seconds } from "./format.ts";
import {
  TICK_PHASE_MEANINGS,
  TICK_PHASES,
  type TickRowView,
  tickRows,
} from "./ticks-view.ts";
import type { Clock } from "./view.ts";

/** Rows the strip shows before Show all. */
const SHOWN = 8;

function Bar({ row }: { row: TickRowView }) {
  if (row.phases.length === 0)
    return <span className="sm mut tkBarNone">no phases timed</span>;
  return (
    <span className="tkBar" aria-hidden="true">
      <span className="tkBarIn" style={{ width: `${row.scale * 100}%` }}>
        {row.phases.map((p) => (
          <span
            key={p.phase}
            className={`tkSeg ph-${p.phase}`}
            style={{ flexGrow: p.share }}
            title={`${p.phase} ${seconds(p.ms)}`}
          />
        ))}
      </span>
    </span>
  );
}

function Detail({ row }: { row: TickRowView }) {
  return (
    <Fold label="Details">
      <dl className="kv tkKv">
        {row.phases.map((p) => (
          <div key={p.phase} style={{ display: "contents" }}>
            <dt>{p.phase}</dt>
            <dd className="m">{seconds(p.ms)}</dd>
          </div>
        ))}
        {row.repos.map((r) => (
          <div key={r.repo} style={{ display: "contents" }}>
            <dt className="m">{r.repo}</dt>
            <dd className="prose">
              <span>
                {r.took}
                {r.phases === "" ? "" : `: ${r.phases}`}
                {r.defect === null ? "" : ` (a defect in ${r.defect})`}
              </span>
            </dd>
          </div>
        ))}
        {row.busy.map((path) => (
          <div key={path} style={{ display: "contents" }}>
            <dt className="m">{path}</dt>
            <dd>busy: another tick held it</dd>
          </div>
        ))}
        {row.skipped.length === 0 ? null : (
          <div style={{ display: "contents" }}>
            <dt>skipped</dt>
            <dd>{row.skipped.join(", ")}</dd>
          </div>
        )}
      </dl>
    </Fold>
  );
}

function TickRow({ row, rest }: { row: TickRowView; rest: boolean }) {
  return (
    <li className={rest ? "tkRow rest" : "tkRow"}>
      <span className="m sm tkAt">{row.at}</span>
      <span className="m tkTook">{row.took}</span>
      <Bar row={row} />
      <span className="sm tkSlow">
        {row.slowest === null ? null : (
          <>
            <span className="mut">slowest </span>
            {row.slowest}
          </>
        )}
      </span>
      <span className="tkMarks">
        {row.marks.map((mark) => (
          <Hint
            key={mark.word}
            className="chipBtn"
            label={mark.word}
            trigger={
              <span className={`chip tkMark r-${mark.tone}`}>{mark.word}</span>
            }
          >
            {mark.meaning}
          </Hint>
        ))}
      </span>
      <span className="sm mut tkBudget">
        {row.budget === null ? null : (
          <>
            <span className="m">{row.budget.remaining}</span> of{" "}
            <span className="m">{row.budget.limit}</span> left
          </>
        )}
      </span>
      <span className="sm mut tkScope">{row.scope}</span>
      <span className="tkDetail">
        <Detail row={row} />
      </span>
    </li>
  );
}

/** The phases the rows shown have, each with its colour and what it is. */
function PhaseKey({ rows }: { rows: TickRowView[] }) {
  const present = new Set(rows.flatMap((r) => r.phases.map((p) => p.phase)));
  return (
    <div className="sm mut tkKey">
      {TICK_PHASES.filter((p) => present.has(p)).map((p) => (
        <Hint
          key={p}
          className="termBtn tkKeyBtn"
          label={`Phase ${p}`}
          trigger={
            <>
              <span className={`tkSw ph-${p}`} aria-hidden="true" />
              {p}
            </>
          }
        >
          <b>{p}</b>: {TICK_PHASE_MEANINGS[p]}
        </Hint>
      ))}
    </div>
  );
}

export function TicksPanel({
  line,
  clock,
}: {
  line: LineSnapshot | null;
  clock: Clock;
}) {
  const [all, setAll] = useState(false);
  const rows = tickRows(line, clock);
  return (
    <section className="panel pTicks" id="ticks" aria-labelledby="h-ticks">
      <div className="panelHead">
        <h2 id="h-ticks">How the ticks ran</h2>
        <PanelHelp panel="How the ticks ran">
          <p>
            Each recent tick, the newest first: how long it took, its own phases
            as a bar beside the longest tick shown, and the slowest single
            phase, one repository's or the tick's own. The budget is the forge's
            rate budget the tick read.
          </p>
          <p>
            A chip marks a tick with a defect, one that skipped its optional
            reads for a low budget, one that found repositories busy under
            another tick, and one that ended with a failure. Open a row for each
            phase and each repository.
          </p>
        </PanelHelp>
        {rows.length > SHOWN ? (
          <button
            className="moreBtn headMore deskToo"
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="emptyLine">
          {line === null
            ? "No tick has written the line yet."
            : "No tick has recorded how it ran yet: the next tick of this version adds the first row."}
        </p>
      ) : (
        <>
          <PhaseKey rows={rows} />
          <ol className={all ? "tkList all" : "tkList"}>
            {rows.map((row, i) => (
              <TickRow row={row} rest={i >= SHOWN} key={row.key} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
