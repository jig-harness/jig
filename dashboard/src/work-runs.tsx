/**
 * A piece of work's page of runs: the log filtered to one target shows, above
 * its rows, each run of that work that ended in the window, newest first,
 * with what its closing report concluded, the next step it suggests and why
 * it fell short. Where the suggested owner and the tick's own `next` differ,
 * both are shown, and the page decides nothing.
 */
import type { LogRow } from "../../plugin/dispatch/lib/log.ts";
import type { Forges } from "./links.ts";
import { type RowClock, type RowView, rowView } from "./log-view.ts";
import { StageChip } from "./icon-word.tsx";
import { Mark } from "./marks.tsx";
import type { LogFilter } from "./search.ts";
import { stageMeaning } from "./status.ts";

export interface WorkView {
  heading: string;
  /** The work's ended rows, newest first, as the log answered them. */
  runs: RowView[];
}

/** The page of the work the filter names; `null` when it names none. */
export function workView(
  rows: LogRow[],
  filter: LogFilter,
  rowClock: RowClock,
  forges: Forges,
): WorkView | null {
  if (filter.target === "") return null;
  const where = filter.repo === "" ? "" : ` in ${filter.repo}`;
  return {
    heading: `Runs of ${filter.target}${where}, newest first`,
    runs: rows
      .filter(
        (r) =>
          r.kind === "ended" &&
          r.target === filter.target &&
          (filter.repo === "" || r.repo === filter.repo),
      )
      .map((r) => rowView(r, rowClock, forges)),
  };
}

/** What a run's report says, or that it left none; a row from before reports were kept shows its reason. */
function RunSaid({ run }: { run: RowView }) {
  const report = run.run;
  if (report === null) return <p className="sm mut">{run.reason}</p>;
  if (report.missing) return <p className="sm runSaid">{report.line}</p>;
  return (
    <dl className="kv runKv">
      {report.evidence.map((row) => (
        <div key={row.k} style={{ display: "contents" }}>
          <dt>{row.k}</dt>
          <dd>{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunItem({ run }: { run: RowView }) {
  return (
    <li className="workRun">
      <div className="workRunTop">
        <span className="m sm mut">{run.time}</span>
        <StageChip stage={run.stage} title={stageMeaning(run.stage)} />
        <span className="cell-cls">
          <Mark role={run.role} /> {run.label}
        </span>
        <span className="sm mut">{run.repo}</span>
      </div>
      <RunSaid run={run} />
    </li>
  );
}

/** The page of the work the filter names, above the log's rows; nothing when it names none. */
export function WorkRuns({
  rows,
  filter,
  rowClock,
  forges,
}: {
  rows: LogRow[];
  filter: LogFilter;
  rowClock: RowClock;
  forges: Forges;
}) {
  const work = workView(rows, filter, rowClock, forges);
  return work === null ? null : (
    <div className="workRuns">
      <h3>{work.heading}</h3>
      {work.runs.length === 0 ? (
        <p className="sm mut">
          No run of this work ended in this window. Widen the window to see
          earlier runs.
        </p>
      ) : (
        <ol className="workRunList">
          {work.runs.map((run) => (
            <RunItem run={run} key={run.key} />
          ))}
        </ol>
      )}
    </div>
  );
}
