/**
 * The host's load at the top of Running: the load factor as a bar with the
 * gauge that binds, what it held or would have held, and each gauge, each
 * kind's reservation and each hold folded below.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { Fold, PanelHelp } from "./fold.tsx";
import { BareWord } from "./icon-word.tsx";
import { GAUGE_ICONS, iconOf } from "./icons.ts";
import { loadView } from "./load-view.ts";

export function LoadGauge({ line }: { line: LineSnapshot | null }) {
  if (line?.load === undefined) return null;
  const view = loadView(line.load);
  return (
    <div className="load" id="load">
      <div className="loadHead">
        <b className="m">Load {view.percent}</b>
        <div className="loadBar" aria-hidden="true">
          <i
            className={view.over ? "over" : ""}
            style={{ width: `${view.width}%` }}
          />
        </div>
        <span className="m sm">{view.binds}</span>
        {view.over ? <BareWord of={GAUGE_ICONS.over} className="sm" /> : null}
        <PanelHelp panel="Load">
          The fullest of the host's gauges against its line, read when the tick
          acts. A launch starts only while every gauge stays under its line with
          its memory reservation counted, and a pickup keeps room for a drive or
          follow-up after it. Until enforcement is on, the tick only reports
          what it would have held.
        </PanelHelp>
      </div>
      <div className="sm mut">{view.summary}</div>
      <Fold label="Each gauge, the reservations and the holds">
        <dl className="kv">
          {view.gauges.map((g) => (
            <div key={g.name} style={{ display: "contents" }}>
              <dt>
                <BareWord of={iconOf(GAUGE_ICONS, g.gauge)}>{g.name}</BareWord>
              </dt>
              <dd>
                <span>
                  <span className="m">{g.fill}</span> · {g.reads} · line{" "}
                  {g.line}
                  {g.over ? (
                    <>
                      {" "}
                      <BareWord of={GAUGE_ICONS.over} />
                    </>
                  ) : null}
                </span>
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
          {view.holds.map((h) => (
            <div key={h.key} style={{ display: "contents" }}>
              <dt className="m">{h.target}</dt>
              <dd>
                <span>{h.text}</span>
              </dd>
            </div>
          ))}
        </dl>
      </Fold>
    </div>
  );
}
