/**
 * What needs you: the person's list. Two rows show on a phone, so the line stays
 * one scroll away; the rest wait behind Show all.
 */
import { useState } from "react";
import { CopyButton } from "./copy.tsx";
import { DecisionText } from "./decision-text.tsx";
import { Evidence, Fold } from "./fold.tsx";
import { Mark, StageChip } from "./marks.tsx";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { type NeedRow, type NeedView, needRows } from "./needs-view.ts";
import { asOfOf, type Clock, type SlotView } from "./view.ts";

function NeedItem({ need, rest }: { need: NeedView; rest: boolean }) {
  return (
    <article className={rest ? "need rest" : "need"}>
      <div className="rowTop">
        <Mark role={need.role} />
        <span className="tgt">{need.target}</span>
        <span className="m sm mut end nowrap">{need.age}</span>
        <span className="br" />
        <span className="m sm mut">{need.repo}</span>
        <StageChip mark={need.mark} stage={need.stage} />
      </div>
      <div className="sm">
        <span className="m">{need.recorded}</span>
        <span className="mut">{need.classNote}</span>
      </div>
      {need.question === null ? null : <p className="q">{need.question}</p>}
      {need.recommendation === null ? null : (
        <p className="sm mut">{need.recommendation}</p>
      )}
      <div className="goto">
        {need.url === null ? null : (
          <a href={need.url} target="_blank" rel="noreferrer noopener">
            {need.goLabel}
          </a>
        )}
        {need.noLink === null ? null : (
          <span className="noLink">{need.noLink}</span>
        )}
        {need.answerLine !== null ? (
          <CopyButton
            text={need.answerLine}
            idle="Copy answer line"
            aria={`Copy the answer line for ${need.target}`}
          />
        ) : need.keyText !== null ? (
          <CopyButton
            text={need.keyText}
            idle="Copy key"
            aria={`Copy key ${need.keyText}`}
          />
        ) : null}
        <Fold label={need.foldLabel}>
          {need.decision === null ? null : (
            <>
              <DecisionText source={need.decision} />
              <div className="copyRow">
                <CopyButton
                  text={need.decision}
                  idle="Copy decision"
                  aria={`Copy the whole decision for ${need.target}`}
                />
              </div>
            </>
          )}
          <Evidence rows={need.evidence} />
        </Fold>
      </div>
    </article>
  );
}

function StuckItem({ slot, rest }: { slot: SlotView; rest: boolean }) {
  return (
    <article className={rest ? "need rest" : "need"}>
      <div className="rowTop">
        <Mark role={slot.role} />
        <span className="tgt">{slot.target}</span>
        <span className="br" />
        <span className="m sm mut">{slot.repo}</span>
        <StageChip mark={slot.mark} stage={slot.stage} />
      </div>
      <div className="sm">
        <span className="m">{slot.fact}</span>
      </div>
      <div className="goto">
        {slot.url === null ? null : (
          <a href={slot.url} target="_blank" rel="noreferrer noopener">
            {slot.target.startsWith("PR #")
              ? "Open the pull request"
              : "Open in the tracker"}
          </a>
        )}
        <Fold label="Evidence">
          <Evidence rows={slot.evidence} />
        </Fold>
      </div>
    </article>
  );
}

function rowKeyOf(row: NeedRow): string {
  if (row.type === "head") return row.head;
  return row.type === "need" ? row.need.rowKey : `stuck ${row.slot.record}`;
}

export function NeedsPanel({
  line,
  clock,
}: {
  line: LineSnapshot;
  clock: Clock;
}) {
  const [all, setAll] = useState(false);
  const rows = needRows(line, clock);
  const count = rows.filter((r) => r.type !== "head").length;
  let seen = 0;
  return (
    <section className="panel pNeeds" aria-labelledby="h-needs">
      <div className="panelHead">
        <h2 id="h-needs">What needs you</h2>
        <span className="asof m">{asOfOf(line, clock.timeZone)}</span>
      </div>
      <div className={all ? "needList all" : "needList"}>
        {rows.map((row, i) => {
          const rest = !all && seen >= 2;
          if (row.type === "head")
            return (
              <div
                className={`groupHead${i === 0 ? " first" : ""}${rest ? " rest" : ""}`}
                key={rowKeyOf(row)}
              >
                {row.head}
              </div>
            );
          seen++;
          return row.type === "need" ? (
            <NeedItem need={row.need} rest={rest} key={rowKeyOf(row)} />
          ) : (
            <StuckItem slot={row.slot} rest={rest} key={rowKeyOf(row)} />
          );
        })}
        {count > 2 ? (
          <button
            className="moreBtn"
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Show only the first 2" : `Show all ${count}`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
