/**
 * The legend at the page's foot, built from the mapping in `status.ts`. It holds
 * no hooks and takes its folds as a component, so the page a refused request
 * gets, which runs no script, can show it with native disclosures.
 */
import type { ComponentType, ReactNode } from "react";
import { Mark } from "./marks.tsx";
import { buildLegend, COUNT_NOTES, STAGE_LEGEND } from "./status.ts";

export type FoldComponent = ComponentType<{
  label: string;
  children: ReactNode;
}>;

export function Legend({ Fold }: { Fold: FoldComponent }) {
  return (
    <section className="panel" id="legend" aria-labelledby="h-legend">
      <h2 id="h-legend">Legend</h2>
      <p className="lede lgMeta">
        Eight words group what the records say. Each outcome class keeps its own
        name everywhere; the word beside it only says what kind of fact it is.
      </p>
      <div className="legend">
        {buildLegend().map((role) => (
          <div className="lgRole" key={role.word}>
            <div>
              <Mark role={role} /> <b>{role.word}</b>
            </div>
            <div>{role.meaning}</div>
            {role.sets.map((s) => (
              <div className="set" key={s.set}>
                <span>{s.set}: </span>
                <span className="m">{s.items}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <Fold label="Stages and their marks">
        <div className="seg">
          {STAGE_LEGEND.map((s) => (
            <span className="chip" key={s.name}>
              <b>{s.mark}</b>
              {s.name}
            </span>
          ))}
        </div>
      </Fold>
      <Fold label="How the numbers are counted">
        <dl className="kv">
          {COUNT_NOTES.map((c) => (
            <div key={c.k} style={{ display: "contents" }}>
              <dt>{c.k}</dt>
              <dd className="prose">{c.v}</dd>
            </div>
          ))}
        </dl>
      </Fold>
    </section>
  );
}
