/**
 * The host's load at the top of Running: the load factor and the gauge that
 * binds, then every gauge against its own line, always open, and what the
 * factor held or would have held with each kind's reservation in one fold
 * below. The gauge row is Running's own, not a shared primitive.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { PanelHelp } from "./fold.tsx";
import { GutterFold } from "./gutter.tsx";
import { BareWord } from "./icon-word.tsx";
import { GAUGE_ICONS, iconOf } from "./icons.ts";
import { type GaugeRow, LINE_AT, loadView, NOT_A_SUM } from "./load-view.ts";

/** One gauge: its icon and name, a bar from 0 to 150% with its line marked, its percent and what it read. */
function Gauge({ row }: { row: GaugeRow }) {
  return (
    <li
      className={`gRow${row.binds ? " binds" : ""}${row.over ? " over" : ""}${row.read ? "" : " unread"}`}
    >
      <span className="gName">
        <BareWord of={iconOf(GAUGE_ICONS, row.gauge)}>{row.name}</BareWord>
        {row.binds ? (
          <>
            {" "}
            <span className="gTag">binds</span>
          </>
        ) : null}
        {row.over ? (
          <>
            {" "}
            <BareWord of={GAUGE_ICONS.over} className="gTag gOverTag" />
          </>
        ) : null}
      </span>
      <span className="gBar" role="img" aria-label={row.label}>
        <span className="gTrack">
          <span className="gFill" style={{ width: `${row.under}%` }} />
          {row.past > 0 ? (
            <span
              className="gPast"
              style={{ left: `${LINE_AT}%`, width: `${row.past}%` }}
            />
          ) : null}
        </span>
        <span className="gLine" style={{ left: `${LINE_AT}%` }} />
      </span>
      <span className="gPct m">{row.fill}</span>
      <span className="gReads sm mut">{row.reads}</span>
    </li>
  );
}

export function LoadGauge({ line }: { line: LineSnapshot | null }) {
  if (line?.load === undefined) return null;
  const view = loadView(line.load);
  const folded = view.holds.length + view.reservations.length > 0;
  return (
    <div className="load" id="load">
      <div className="loadHead">
        <p className="loadTitle">
          <b className="m">{view.figure}</b>, {view.binds}
        </p>
        <PanelHelp panel="Load">
          Each gauge's fill against its own line, read when the tick acts; 100%
          is a gauge at its line, and the bar runs to 150%. A launch starts only
          while every gauge stays under its line with its memory reservation
          counted, and a pickup keeps room for a drive or follow-up after it.
          Until enforcement is on, the tick only reports what it would have
          held.
        </PanelHelp>
      </div>
      <p className="sm mut">{NOT_A_SUM}</p>
      <ul className="gauges">
        {view.gauges.map((g) => (
          <Gauge key={g.gauge} row={g} />
        ))}
      </ul>
      {folded ? (
        <GutterFold
          className="loadFold"
          label={view.title}
          head={<span className="sm">{view.title}</span>}
        >
          <dl className="kv">
            {view.holds.map((h) => (
              <div key={h.key} style={{ display: "contents" }}>
                <dt className="m">{h.target}</dt>
                <dd>
                  <span>{h.text}</span>
                </dd>
              </div>
            ))}
            {view.reservations.map((r) => (
              <div key={r.kind} style={{ display: "contents" }}>
                <dt>Reserves · {r.kind}</dt>
                <dd>
                  <span>{r.text}</span>
                </dd>
              </div>
            ))}
          </dl>
        </GutterFold>
      ) : null}
    </div>
  );
}
