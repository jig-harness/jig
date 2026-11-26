import { FollowupBadge } from "./followups.tsx";
import { runningFollowup } from "./followup-view.ts";
import { ItemTitle, RepoLink } from "./pr.tsx";
import { LinkedDetail, WorkLead } from "./work.tsx";
/**
 * Needs you: the person's list, one group per act. Each card opens with the act,
 * then, for a parked need, one short row per decision (`decision-rows.tsx`)
 * to pick an answer on, and who it waits on; for any other need, the ask and
 * the recommended option with what it changes and costs. The steps and the
 * evidence are folded. Two rows show on a phone; the rest wait behind Show all.
 * Where a parked drive's card can send its answers, the head offers Send's
 * settings (`send.tsx`). The cards an answer hid fold into one line above
 * the list (`AnsweredHolds`).
 */
import { type ReactNode, useId, useRef, useState } from "react";
import { DecisionCounts, filterAnswerStates } from "./decision-counts.tsx";
import { needCard, readyNeedCard, slotCard } from "./cards.ts";
import { CopyButton } from "./copy.tsx";
import { BoardCardLead, BoardStatus } from "./board-status.tsx";
import { CommitControls, DecisionRows } from "./decision-rows.tsx";
import { facetAttrs, memberAttrs } from "./facets.ts";
import { answerCommentUrl, cardAttrs } from "./keys.ts";
import { DecisionText, InlineDecisionText } from "./decision-text.tsx";
import { Evidence, PanelHelp, StageHint } from "./fold.tsx";
import { ago } from "./format.ts";
import { GutterCard, GutterFold } from "./gutter.tsx";
import { ActPill, BareWord, Glyph } from "./icon-word.tsx";
import { ACT_ICONS, CAUSE_ICONS, EVERYONE_ICONS, iconOf } from "./icons.ts";
import { Mark } from "./marks.tsx";
import { ReadyConditions } from "./merge.tsx";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  type NeedRow,
  type NeedView,
  type ReadyNeedView,
  needRows,
} from "./needs-view.ts";
import { OptionText } from "./option-text.tsx";
import { GroupNeedItem } from "./question-group-card.tsx";
import { SettledRecently } from "./settled.tsx";
import { NoSend } from "./send.tsx";
import { SendSettings, SendSettingsToggle } from "./send-settings.tsx";
import { storedListUntrusted, useKeptTokens } from "./forge-token.ts";
import { disarmOnLeave, usePicking } from "./use-picking.ts";
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
      {need.board === undefined ? null : (
        <>
          <p className="q">{need.board.says}</p>
          <ReadyConditions conditions={need.board.conditions} />
        </>
      )}
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
      {need.board === undefined ? null : (
        <>
          <p className="sm">
            Board action: {need.board.boardAct ?? "needs a person"}.
          </p>
          {need.board.failing.length === 0 ? null : (
            <p className="sm">
              Failing: {need.board.failing.join(", ")}
              {need.board.failingOmitted > 0
                ? ` (+${need.board.failingOmitted} more)`
                : ""}
              .
            </p>
          )}
        </>
      )}
      <LinkedDetail repo={need.repo} target={need.target} links={need.links} />
    </>
  );
}

/** The filter reads these facts even while a group is folded. */
function needFacetAttrs(
  row: NeedCardRow,
  clock: Clock,
): Record<string, string> {
  const bucket = (iso: string) => {
    const hours = (clock.nowMs - Date.parse(iso)) / 3_600_000;
    return hours < 1
      ? "Under 1 hour"
      : hours < 24
        ? "1–24 hours"
        : "1 day or more";
  };
  if (row.type === "ready") {
    return {
      ...facetAttrs({
        act: [row.ready.act],
        repo: [row.ready.repo],
        person: [],
        stage: [],
        age: [bucket(row.since)],
      }),
      "data-facet-since": row.since,
      "data-facet-age-label": row.ready.age,
      "data-facet-target": row.ready.target,
    };
  }
  const card = row.type === "need" ? row.need : row.slot;
  // A question group's card is found by any of its targets' repositories, stages and ages; one target holds each combination.
  const members = row.type === "need" ? (row.need.group?.members ?? []) : [];
  const since = Date.parse(row.since);
  const each = (of: (c: { repo: string; stage: string }) => string) =>
    members.length === 0 ? [of(card)] : [...new Set(members.map(of))];
  const ages = [
    ...new Set(
      members.length === 0
        ? [bucket(row.since)]
        : members.map((m) => bucket(m.since)),
    ),
  ];
  return {
    ...facetAttrs({
      act: [row.type === "need" ? row.need.act : "Investigate"],
      repo: each((c) => c.repo),
      person: row.type === "need" ? row.need.people : [],
      stage: each((c) => c.stage),
      age: ages,
    }),
    ...memberAttrs(
      members.map((m) => ({
        repo: [m.repo],
        person: m.people,
        stage: [m.stage],
        age: [bucket(m.since)],
      })),
    ),
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
  const attrs = cardAttrs({ ...needCard(need, picking.commit), picks });
  const commentUrl = picks ? answerCommentUrl(need.url) : null;
  if (commentUrl !== null) attrs["data-pr"] = commentUrl;
  return (
    <GutterCard
      className={rest ? "need groupRest" : "need"}
      cardRef={card}
      attrs={{ ...attrs, ...facets }}
      label={`${need.foldLabel} for ${need.target}`}
      onBlur={disarmOnLeave(picking)}
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

function ReadyNeedItem({
  card,
  rest,
  facets,
}: {
  card: ReadyNeedView;
  rest: boolean;
  facets: Record<string, string>;
}) {
  const info = readyNeedCard(card);
  return (
    <GutterCard
      className={rest ? "need mCard groupRest" : "need mCard"}
      attrs={{ ...cardAttrs(info), ...facets }}
      label={`Ready conditions for ${card.target}`}
      face={
        <>
          <BoardCardLead
            repo={card.repo}
            target={card.target}
            url={card.url}
            title={card.title}
            links={card.links}
            age={card.age}
            action={card.boardAct}
          >
            <ActPill act={card.act} />
            <Mark role={card.role} />
          </BoardCardLead>
          <ItemTitle title={card.title} />
          <p className="q">{card.says}</p>
          <BoardStatus
            failing={card.failing}
            failingOmitted={card.failingOmitted}
            unblocks={card.unblocks}
          />
          <div className="goto">
            <span className="m sm mCommand">{card.command}</span>
            <CopyButton
              text={card.command}
              idle="Copy jig ask line"
              aria={`Copy the ${info.commandLabel} for ${card.target}`}
            />
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

/** How many needs the cards hold: a question group's card holds one per target. */
function needsIn(cards: NeedCardRow[]): number {
  return cards.reduce(
    (n, row) =>
      n + (row.type === "need" ? (row.need.group?.members.length ?? 1) : 1),
    0,
  );
}

function NeedGroup({
  group,
  clock,
  defaultOpen,
  resetKey,
}: {
  group: NeedGroupView;
  clock: Clock;
  defaultOpen: boolean;
  resetKey: string;
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
        resetKey={resetKey}
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
            <span className="mut" aria-hidden="true">
              ·
            </span>{" "}
            <span className="m" data-group-count="">
              {needsIn(cards)}
            </span>{" "}
            <span className="sm mut" data-group-oldest="">
              {oldest === undefined
                ? null
                : `Oldest ${ago(Date.parse(oldest.since), clock.nowMs)}`}
            </span>{" "}
            <span data-group-decisions="">
              <DecisionCounts rows={cards} />
            </span>
          </h3>
        }
      >
        {cards.map((row, i) => {
          const rest = i >= INITIAL_GROUP_SIZE;
          const facets = needFacetAttrs(row, clock);
          return row.type === "need" && row.need.group !== undefined ? (
            <GroupNeedItem
              key={row.need.rowKey}
              need={row.need}
              rest={rest}
              facets={facets}
            />
          ) : row.type === "need" ? (
            <NeedItem
              key={row.need.rowKey}
              need={row.need}
              rest={rest}
              facets={facets}
            />
          ) : row.type === "ready" ? (
            <ReadyNeedItem
              key={row.ready.rowKey}
              card={row.ready}
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

/** The repositories of the cards that can send, for the tokens' scope. */
function sendableRepos(rows: NeedRow[]): string[] {
  const repos = rows.flatMap((row) =>
    row.type !== "need"
      ? []
      : (row.need.group?.members ?? [row.need]).flatMap((n) =>
          "to" in n.send ? [n.send.to.repo] : [],
        ),
  );
  return [...new Set(repos)].sort((a, b) => a.localeCompare(b));
}

/** Send's settings: the toggle in the panel's head, shown while a card can send, a token is kept or a stored list was refused, and the panel it opens. */
function useSendSettings(rows: NeedRow[]): {
  toggle: ReactNode;
  panel: ReactNode;
} {
  // Every card the line holds, whoever it waits on: the tokens cover them all.
  const sendable = sendableRepos(rows);
  const { tokens } = useKeptTokens();
  const [open, setOpen] = useState(false);
  const id = useId();
  return {
    toggle:
      sendable.length === 0 &&
      tokens.length === 0 &&
      !storedListUntrusted() ? null : (
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
  /** Null before any tick has run: the panel then holds only the token settings. */
  line: LineSnapshot | null;
  clock: Clock;
  filterActive?: boolean;
  /** Changes whenever the card filter does, reopening matching groups. */
  filterKey?: string;
}) {
  const allRows = line === null ? [] : needRows(line, clock);
  const [everyone, setEveryone] = useState("any");
  const rows = filterAnswerStates(allRows, everyone);
  const groups = groupRows(rows);
  const decisionWaits = groups.some(
    ({ head }) => head === "Decide" || head === "Authorize",
  );
  const send = useSendSettings(allRows);
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
        {everyone !== "any" ||
        allRows.some(
          (row) => row.type === "need" && row.need.answerNotes.length > 0,
        ) ? (
          <label className="answerFilter sm">
            <span className="mut">For everyone</span>
            <select
              value={everyone}
              onChange={(event) => setEveryone(event.currentTarget.value)}
            >
              <option value="any">All states</option>
              <option value="stale">Stale</option>
              <option value="disputed">Disputed</option>
              <option value="from the line">From the line</option>
            </select>
          </label>
        ) : null}
      </div>
      <DecisionCounts rows={rows} />
      {send.panel}
      {line === null ? null : <AnsweredHolds line={line} />}
      <div className="needList">
        {groups.map((group) => (
          <NeedGroup
            key={group.head}
            group={group}
            clock={clock}
            resetKey={filterKey}
            defaultOpen={
              filterActive || group.head !== "Investigate" || !decisionWaits
            }
          />
        ))}
      </div>
      {line === null ? null : <SettledRecently line={line} clock={clock} />}
    </section>
  );
}
