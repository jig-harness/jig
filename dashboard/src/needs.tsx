/**
 * What needs you: the person's list. Two rows show on a phone, so what is
 * running stays one scroll away; the rest wait behind Show all.
 */
import { useId, useState } from "react";
import { CopyButton } from "./copy.tsx";
import { DecisionText } from "./decision-text.tsx";
import { Evidence, Fold, PanelHelp, StageHint } from "./fold.tsx";
import { Mark } from "./marks.tsx";
import { MoreToggle, SHOWN_CLOSED, useShowAll } from "./more.tsx";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { type NeedRow, type NeedView, needRows } from "./needs-view.ts";
import { answerText, useReplies } from "./replies.ts";
import type { Clock, SlotView } from "./view.ts";

/** The drafts beside a decision, kept in this browser, and the Copy that joins them to their keys. */
function Replies({ need }: { need: NeedView }) {
  const [replies, setReply] = useReplies(need.repo, need.answerKeys);
  const drafted = replies.some((r) => r.trim() !== "");
  const [open, setOpen] = useState(drafted);
  const id = useId();
  return (
    <>
      <CopyButton
        text={answerText(need.answerKeys, replies)}
        idle={drafted ? "Copy answer" : "Copy answer line"}
        aria={`Copy the answer ${drafted ? "" : "line "}for ${need.target}`}
      />
      <button
        className="foldBtn"
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide reply" : drafted ? "Edit reply" : "Write reply"}
      </button>
      {open ? (
        <div className="replies" id={id}>
          {need.answerKeys.map((key, i) => (
            <label className="reply" key={key}>
              <span className="sm mut">
                Reply to <span className="m">{key}</span>
              </span>
              <textarea
                rows={2}
                value={replies[i] ?? ""}
                placeholder="Your answer, such as an option and why"
                onChange={(event) => setReply(i, event.currentTarget.value)}
              />
            </label>
          ))}
          <p className="sm mut">
            Kept in this browser only. Copy answer takes{" "}
            <span className="m">answer {need.answerKeys[0]}: …</span> with your
            reply, to paste as a comment on the pull request.
          </p>
        </div>
      ) : null}
    </>
  );
}

function NeedItem({ need, rest }: { need: NeedView; rest: boolean }) {
  return (
    <article className={rest ? "need rest" : "need"}>
      <div className="rowTop">
        <Mark role={need.role} />
        <span className="tgt">{need.target}</span>
        <span className="m sm mut end nowrap">{need.age}</span>
        <span className="br" />
        <span className="m sm mut">{need.repo}</span>
        <StageHint mark={need.mark} stage={need.stage} />
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
        {need.answerKeys.length > 0 ? (
          <Replies need={need} />
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
        <StageHint mark={slot.mark} stage={slot.stage} />
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
  const [all, setAll, panel] = useShowAll();
  const rows = needRows(line, clock);
  const count = rows.filter((r) => r.type !== "head").length;
  let seen = 0;
  return (
    <section className="panel pNeeds" aria-labelledby="h-needs" ref={panel}>
      <div className="panelHead">
        <h2 id="h-needs">What needs you</h2>
        <PanelHelp panel="What needs you">
          Stops only a person can settle: decisions a drive parked, drives
          stopped on something the dispatcher may not decide, stalled pickups,
          and sessions that are not moving. Decisions come first, oldest first.
          Answer on the pull request; the next tick re-arms the drive.
        </PanelHelp>
        <MoreToggle count={count} all={all} setAll={setAll} where="head" />
      </div>
      <div className={all ? "needList all" : "needList"}>
        {rows.map((row, i) => {
          const rest = !all && seen >= SHOWN_CLOSED;
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
        <MoreToggle count={count} all={all} setAll={setAll} where="foot" />
      </div>
    </section>
  );
}
