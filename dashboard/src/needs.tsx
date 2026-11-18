import { FollowupBadge } from "./followups.tsx";
import { runningFollowup } from "./followup-view.ts";
import { ItemTitle, RepoLink } from "./pr.tsx";
import { LinkedDetail, WorkLead } from "./work.tsx";
/**
 * Needs you: the person's list, one group per act. Each card opens with the
 * act, then, for a parked need, one short row per decision (`decision-rows.tsx`)
 * to pick an answer on, and who it waits on; for any other need, the ask and
 * the recommended option with what it changes and costs. The steps and the
 * evidence are folded. Two rows show on a phone; the rest wait behind Show all.
 * Where a parked drive's card can send its answers, the head offers Send's
 * settings (`send.tsx`).
 */
import { type ReactNode, useId, useRef, useState } from "react";
import { needCard, slotCard } from "./cards.ts";
import { CopyButton } from "./copy.tsx";
import { CommitControls, DecisionRows } from "./decision-rows.tsx";
import { facetAttrs } from "./facets.ts";
import { cardAttrs } from "./keys.ts";
import { DecisionText, InlineDecisionText } from "./decision-text.tsx";
import { Evidence, PanelHelp, StageHint } from "./fold.tsx";
import { ago } from "./format.ts";
import { GutterCard, GutterFold } from "./gutter.tsx";
import { ActPill, BareWord, Glyph } from "./icon-word.tsx";
import { ACT_ICONS, CAUSE_ICONS, EVERYONE_ICONS, iconOf } from "./icons.ts";
import { Mark } from "./marks.tsx";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { type NeedRow, type NeedView, needRows } from "./needs-view.ts";
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

/** Answered holds remain visible while their facts stand. */
export function AnsweredHolds({
  line,
}: {
  line: Pick<LineSnapshot, "answeredHolds">;
}) {
  return (
    <>
      {(line.answeredHolds ?? []).map((h) => (
        <p className="sm answeredHold" key={`${h.repo} ${h.target}`}>
          {h.repo} {h.target}: {h.why}
        </p>
      ))}
    </>
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

/** The filter reads these facts even while a group is folded. */
function needFacetAttrs(
  row: NeedCardRow,
  clock: Clock,
): Record<string, string> {
  const card = row.type === "need" ? row.need : row.slot;
  const since = Date.parse(row.since);
  const hours = (clock.nowMs - since) / 3_600_000;
  const age =
    hours < 1 ? "Under 1 hour" : hours < 24 ? "1–24 hours" : "1 day or more";
  return {
    ...facetAttrs({
      act: [row.type === "need" ? row.need.act : "Investigate"],
      repo: [card.repo],
      person: row.type === "need" ? row.need.people : [],
      stage: [card.stage],
      age: [age],
    }),
    "data-facet-since": row.since,
    "data-facet-age-label":
      row.type === "need" ? row.need.age : ago(since, clock.nowMs),
    "data-facet-target": card.target,
  };
}

function NeedItem({
  need,
  rest,
  facets,
}: {
  need: NeedView;
  rest: boolean;
  facets: Record<string, string>;
}) {
  const card = useRef<HTMLElement | null>(null);
  const picking = usePicking(need, card);
  const picks = need.rows.length > 0;
  return (
    <GutterCard
      className={rest ? "need groupRest" : "need"}
      cardRef={card}
      attrs={{
        ...cardAttrs({ ...needCard(need, picking.commit), picks }),
        ...facets,
      }}
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

function StuckItem({
  slot,
  rest,
  facets,
}: {
  slot: SlotView;
  rest: boolean;
  facets: Record<string, string>;
}) {
  return (
    <GutterCard
      className={rest ? "need groupRest" : "need"}
      attrs={{ ...cardAttrs(slotCard(slot, "needs")), ...facets }}
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

type NeedCardRow = Exclude<NeedRow, { type: "head" }>;

interface NeedGroupView {
  head: string;
  cards: NeedCardRow[];
}

function groupRows(rows: NeedRow[]): NeedGroupView[] {
  const groups: NeedGroupView[] = [];
  for (const row of rows) {
    if (row.type === "head") groups.push({ head: row.head, cards: [] });
    else groups.at(-1)?.cards.push(row);
  }
  return groups;
}

const INITIAL_GROUP_SIZE = 10;

function NeedGroup({
  group,
  clock,
  defaultOpen,
}: {
  group: NeedGroupView;
  clock: Clock;
  defaultOpen: boolean;
}) {
  const [all, setAll] = useState(false);
  const { head, cards } = group;
  const oldest = cards[0];
  return (
    <div data-facet-group="">
      <GutterFold
        className={all ? "needGroup all" : "needGroup"}
        label={`${head} group`}
        defaultOpen={defaultOpen}
        keepMounted
        head={
          <h3 className="needGroupTitle">
            <span className="headWord">
              <Glyph
                of={iconOf(
                  ACT_ICONS,
                  head === "Not moving" ? "Investigate" : head,
                )}
                size={16}
              />
              {head}
            </span>{" "}
            <span className="m" data-group-count="">
              {cards.length}
            </span>{" "}
            <span className="sm mut" data-group-oldest="">
              {oldest === undefined
                ? null
                : `Oldest ${ago(Date.parse(oldest.since), clock.nowMs)}`}
            </span>
          </h3>
        }
      >
        {cards.map((row, i) => {
          const rest = i >= INITIAL_GROUP_SIZE;
          const facets = needFacetAttrs(row, clock);
          return row.type === "need" ? (
            <NeedItem
              key={row.need.rowKey}
              need={row.need}
              rest={rest}
              facets={facets}
            />
          ) : (
            <StuckItem
              key={row.slot.record}
              slot={row.slot}
              rest={rest}
              facets={facets}
            />
          );
        })}
        {cards.length > INITIAL_GROUP_SIZE ? (
          <button
            className="moreBtn deskToo"
            type="button"
            data-group-more=""
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Show fewer" : `Show all ${cards.length}`}
          </button>
        ) : null}
      </GutterFold>
    </div>
  );
}

/** The repositories of the cards that can send, for the token's scope. */
function sendableRepos(rows: NeedRow[]): string[] {
  const repos = rows.flatMap((row) =>
    row.type === "need" && "to" in row.need.send ? [row.need.send.to.repo] : [],
  );
  return [...new Set(repos)].sort((a, b) => a.localeCompare(b));
}

/** Send's settings: the toggle in the panel's head, shown while a card can send or a token is kept, and the panel it opens. */
function useSendSettings(rows: NeedRow[]): {
  toggle: ReactNode;
  panel: ReactNode;
} {
  // Every card the line holds, whoever it waits on: the token covers them all.
  const sendable = sendableRepos(rows);
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
  filterActive = false,
  filterKey = "",
}: {
  line: LineSnapshot;
  clock: Clock;
  filterActive?: boolean;
  /** Changes whenever the card filter does, reopening matching groups. */
  filterKey?: string;
}) {
  const rows = needRows(line, clock);
  const groups = groupRows(rows);
  const decisionWaits = groups.some(
    ({ head }) => head === "Decide" || head === "Authorize",
  );
  const send = useSendSettings(rows);
  return (
    <section className="panel pNeeds" aria-labelledby="h-needs">
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
      </div>
      {send.panel}
      <AnsweredHolds line={line} />
      <div className="needList">
        {groups.map((group) => (
          <NeedGroup
            key={`${group.head}:${filterKey}`}
            group={group}
            clock={clock}
            defaultOpen={
              filterActive || group.head !== "Investigate" || !decisionWaits
            }
          />
        ))}
      </div>
    </section>
  );
}
