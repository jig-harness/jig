import { FollowupBadge } from "./followups.tsx";
import { runningFollowup } from "./followup-view.ts";
import { ItemTitle, RepoLink } from "./pr.tsx";
import { LinkedDetail, WorkLead } from "./work.tsx";
/**
 * Needs you: the person's list, one group per act under a heading with its
 * count; the act's pill is the card's alone. Each card opens with the act,
 * then, for a parked need, one short row per decision (`decision-rows.tsx`)
 * to pick an answer on, and who it waits on; for any other need, the ask and
 * the recommended option with what it changes and costs. The steps and the
 * evidence are folded. Two rows show on a phone; the rest wait behind Show all.
 * Where a parked drive's card can send its answers, the head offers Send's
 * settings (`send.tsx`). The cards an answer hid fold into one line above
 * the list (`AnsweredHolds`).
 */
import { type ReactNode, useId, useRef, useState } from "react";
import { needCard, slotCard } from "./cards.ts";
import { CopyButton } from "./copy.tsx";
import { CommitControls, DecisionRows } from "./decision-rows.tsx";
import { cardAttrs } from "./keys.ts";
import { DecisionText, InlineDecisionText } from "./decision-text.tsx";
import { Evidence, PanelHelp, StageHint } from "./fold.tsx";
import { GutterCard } from "./gutter.tsx";
import { ActPill, BareWord, Glyph } from "./icon-word.tsx";
import { ACT_ICONS, CAUSE_ICONS, EVERYONE_ICONS, iconOf } from "./icons.ts";
import { Mark } from "./marks.tsx";
import { MoreToggle, SHOWN_CLOSED, useShowAll } from "./more.tsx";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  type NeedRow,
  type NeedView,
  needPeopleOf,
  needRows,
} from "./needs-view.ts";
import { OptionText } from "./option-text.tsx";
import { NoSend, SendSettings, SendSettingsToggle } from "./send.tsx";
import { useKeptToken } from "./forge-token.ts";
import { usePicking } from "./use-picking.ts";
import type { Clock, SlotView } from "./view.ts";

/** A step's text with its `code` spans set as code; nothing else in it is read as Markdown. */
function StepText({ text }: { text: string }) {
  const parts = text.split("`");
  // An unpaired backtick is text.
  if (parts.length % 2 === 0) return <span>{text}</span>;
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code className="m" key={`code ${part}`}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** The steps for a person, as a checklist a person ticks while they work through it; nothing is kept. */
function Steps({ steps, target }: { steps: string[]; target: string }) {
  return (
    <div className="steps">
      <h3>Steps for you</h3>
      <ul>
        {steps.map((step, i) => (
          <li key={step}>
            <label>
              <input
                type="checkbox"
                aria-label={`Step ${i + 1} for ${target}: ${step}`}
              />{" "}
              <StepText text={step} />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Who a need waits on, as its parks name them. */
function WaitsOn({ need }: { need: NeedView }) {
  return need.people.length === 0 ? null : (
    <p className="sm waitsOn">
      Waits on <span className="m">{need.people.join(", ")}</span>
    </p>
  );
}

/** What the cards say of the answers received: stale or disputed answers read on every card, whether or not it has rows to pick. */
function AnswerNotes({ need }: { need: NeedView }) {
  return (
    <>
      {need.answerNotes.map((note) => (
        <p className="sm answers" key={note.text}>
          <BareWord of={iconOf(EVERYONE_ICONS, note.state)}>
            {Object.hasOwn(EVERYONE_ICONS, note.state)
              ? note.text
              : `${note.state}: ${note.text}`}
          </BareWord>
        </p>
      ))}
    </>
  );
}

/** What the need's run concluded, from its closing report, as context for its question. */
function Concluded({ need }: { need: NeedView }) {
  return need.concluded === null ? null : (
    <p className="sm mut concluded">The run concluded: {need.concluded}</p>
  );
}

/** The tick's outcome, distinguished from a browser's posted comment. */
export function ActedAnswers({ need }: { need: Pick<NeedView, "acted"> }) {
  return (
    <>
      {need.acted.map((a) => (
        <p className="sm actedAnswer" key={a.key}>
          {a.author} chose {a.option}:{" "}
          {a.outcome === "done"
            ? "carried out"
            : a.outcome === "refused"
              ? "refused"
              : a.outcome === "held"
                ? "held"
                : "the tick is carrying it out"}
          {a.detail === null ? "." : ` — ${a.detail}`}
        </p>
      ))}
    </>
  );
}

/**
 * The cards a person's answer hid while their facts stand, folded into one
 * quiet line with their count, so the notes never push the work down; the
 * line opens to one note per hidden card.
 */
export function AnsweredHolds({
  line,
}: {
  line: Pick<LineSnapshot, "answeredHolds">;
}) {
  const holds = line.answeredHolds ?? [];
  const [open, setOpen] = useState(false);
  const id = useId();
  if (holds.length === 0) return null;
  const hidden =
    holds.length === 1
      ? "1 card hidden by an answer"
      : `${holds.length} cards hidden by answers`;
  return (
    <div className="answeredHolds">
      <button
        className="heldToggle"
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {hidden} · {open ? "hide" : "show"}
      </button>
      <ul id={id} hidden={!open}>
        {holds.map((h) => (
          <li className="sm answeredHold" key={`${h.repo} ${h.target}`}>
            {h.repo} {h.target}: {h.why}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a card with no decision to pick says first, after its act: the ask, the recommended option with what it changes and costs, and who it waits on. */
function NeedAsk({ need }: { need: NeedView }) {
  return (
    <>
      {need.question === null ? null : <p className="q">{need.question}</p>}
      <Concluded need={need} />
      {need.recommended === null ? null : (
        <p className="sm rec">
          Recommended: <OptionText option={need.recommended} />
        </p>
      )}
      {need.recommendation === null ? null : (
        <p className="sm mut">
          <InlineDecisionText source={need.recommendation} />
        </p>
      )}
      <AnswerNotes need={need} />
      <WaitsOn need={need} />
    </>
  );
}

/** What an opened card shows: the other options where no row shows them, the steps for a person as a checklist, the whole decision and the evidence. */
function NeedDetail({ need }: { need: NeedView }) {
  return (
    <>
      {need.rows.length > 0 || need.otherOptions.length === 0 ? null : (
        <div className="options">
          <h3>Other options</h3>
          <ul>
            {need.otherOptions.map((o) => (
              <li key={o.name}>
                <OptionText option={o} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {need.steps.length === 0 ? null : (
        <Steps steps={need.steps} target={need.target} />
      )}
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
      <LinkedDetail repo={need.repo} target={need.target} links={need.links} />
    </>
  );
}

function NeedItem({ need, rest }: { need: NeedView; rest: boolean }) {
  const card = useRef<HTMLElement | null>(null);
  const picking = usePicking(need, card);
  const picks = need.rows.length > 0;
  return (
    <GutterCard
      className={rest ? "need rest" : "need"}
      cardRef={card}
      attrs={cardAttrs({ ...needCard(need, picking.commit), picks })}
      label={`${need.foldLabel} for ${need.target}`}
      onBlur={(event) => {
        // Copy's first step lasts while focus stays on the card, or in the palette that copies it.
        const to = event.relatedTarget;
        if (
          to instanceof Element &&
          (event.currentTarget.contains(to) ||
            to.closest(".palette, .clip") !== null)
        )
          return;
        picking.disarm();
      }}
      face={
        <>
          <div className="rowTop">
            <ActPill act={need.act} />
            <Mark role={need.role} />
            <WorkLead
              repo={need.repo}
              target={need.target}
              url={need.url}
              title={need.title}
              links={need.links}
            />
            <span className="m sm mut end nowrap">{need.age}</span>
            <span className="br" />
            <RepoLink repo={need.repo} url={need.url} />
            <StageHint stage={need.stage} />
            <FollowupBadge
              label={
                need.stage === "followup" ? "Follow-up needs attention" : null
              }
            />
          </div>
          <ItemTitle title={need.title} />
          {picks ? (
            <>
              <Concluded need={need} />
              <DecisionRows need={need} picking={picking} />
              <AnswerNotes need={need} />
              <WaitsOn need={need} />
            </>
          ) : (
            <NeedAsk need={need} />
          )}
          <div className="sm">
            <BareWord of={iconOf(CAUSE_ICONS, need.cause)} className="m">
              {need.recorded}
            </BareWord>
            <span className="mut">{need.classNote}</span>
          </div>
          <div className="goto">
            {need.noLink === null ? null : (
              <span className="noLink">{need.noLink}</span>
            )}
            {picks ? (
              <CommitControls need={need} picking={picking} />
            ) : need.keyText !== null ? (
              <CopyButton
                text={need.keyText}
                idle="Copy key"
                aria={`Copy key ${need.keyText}`}
              />
            ) : null}
          </div>
          <ActedAnswers need={need} />
          <NoSend need={need} />
        </>
      }
      detail={<NeedDetail need={need} />}
    />
  );
}

function StuckItem({ slot, rest }: { slot: SlotView; rest: boolean }) {
  return (
    <GutterCard
      className={rest ? "need rest" : "need"}
      attrs={cardAttrs(slotCard(slot, "needs"))}
      label={`Evidence for ${slot.target}`}
      face={
        <>
          <div className="rowTop">
            <Mark role={slot.role} />
            <WorkLead
              repo={slot.repo}
              target={slot.target}
              url={slot.url}
              title={slot.title}
              links={slot.links}
            />
            <span className="br" />
            <RepoLink repo={slot.repo} url={slot.url} />
            <StageHint stage={slot.stage} />
            <FollowupBadge
              label={
                slot.stage === "followup" ? runningFollowup(slot.kind) : null
              }
            />
          </div>
          <ItemTitle title={slot.title} />
          <div className="sm">
            <span className="m">{slot.fact}</span>
          </div>
          {slot.noLink === null ? null : (
            <div className="goto">
              <span className="noLink">{slot.noLink}</span>
            </div>
          )}
        </>
      }
      detail={
        <>
          <Evidence rows={slot.evidence} />
          <LinkedDetail
            repo={slot.repo}
            target={slot.target}
            links={slot.links}
          />
        </>
      }
    />
  );
}

function rowKeyOf(row: NeedRow): string {
  if (row.type === "head") return row.head;
  return row.type === "need" ? row.need.rowKey : `stuck ${row.slot.record}`;
}

/** The repositories of the cards that can send, for the token's scope. */
function sendableRepos(rows: NeedRow[]): string[] {
  const repos = rows.flatMap((row) =>
    row.type === "need" && "to" in row.need.send ? [row.need.send.to.repo] : [],
  );
  return [...new Set(repos)].sort((a, b) => a.localeCompare(b));
}

/** Send's settings: the toggle in the panel's head, shown while a card can send or a token is kept, and the panel it opens. */
function useSendSettings(
  line: LineSnapshot,
  clock: Clock,
): { toggle: ReactNode; panel: ReactNode } {
  // Every card the line holds, whoever it waits on: the token covers them all.
  const sendable = sendableRepos(needRows(line, clock));
  const { kept } = useKeptToken();
  const [open, setOpen] = useState(false);
  const id = useId();
  return {
    toggle:
      sendable.length === 0 && kept === null ? null : (
        <SendSettingsToggle
          open={open}
          onToggle={() => setOpen(!open)}
          controls={id}
        />
      ),
    panel: open ? (
      <SendSettings id={id} repos={sendable} onClose={() => setOpen(false)} />
    ) : null,
  };
}

export function NeedsPanel({
  line,
  clock,
}: {
  line: LineSnapshot;
  clock: Clock;
}) {
  const [all, setAll, panel] = useShowAll();
  const people = needPeopleOf(line);
  const [chosen, setPerson] = useState<string | null>(null);
  // A person the newest line no longer names is no filter.
  const person = chosen !== null && people.includes(chosen) ? chosen : null;
  const rows = needRows(line, clock, person);
  const count = rows.filter((r) => r.type !== "head").length;
  const send = useSendSettings(line, clock);
  let seen = 0;
  return (
    <section className="panel pNeeds" aria-labelledby="h-needs" ref={panel}>
      <div className="panelHead">
        <h2 id="h-needs">What needs you</h2>
        <PanelHelp panel="What needs you">
          Stops only a person can settle, grouped by what you do: Merge, Decide
          among framed options, Authorize what only a person may, Reply to a
          person or a waiting session, Do a step outside the line, or
          Investigate what the line could not recover. Oldest first in each.
          Answer on the pull request, by pasting what a card copies or with its
          Send; the next tick re-arms the drive.
        </PanelHelp>
        {send.toggle}
        {people.length === 0 ? null : (
          <label className="personFilter sm">
            <span className="mut">Waits on</span>
            <select
              value={person ?? ""}
              onChange={(event) => setPerson(event.currentTarget.value || null)}
            >
              <option value="">anyone</option>
              {people.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <MoreToggle count={count} all={all} setAll={setAll} where="head" />
      </div>
      {send.panel}
      <AnsweredHolds line={line} />
      <div className={all ? "needList all" : "needList"}>
        {rows.map((row, i) => {
          const rest = !all && seen >= SHOWN_CLOSED;
          if (row.type === "head")
            return (
              <div
                className={`groupHead groupWord${i === 0 ? " first" : ""}${rest ? " rest" : ""}`}
                key={rowKeyOf(row)}
              >
                <span className="headWord">
                  <Glyph of={iconOf(ACT_ICONS, row.head)} size={16} />
                  {row.head}
                  <span className="groupCount"> · {row.count}</span>
                </span>
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
