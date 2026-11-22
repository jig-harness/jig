/**
 * A question group's card on Needs you: the question once, how many targets
 * it covers, and the list of them, each with its repository, link, age and
 * what became of its answer, and a box to leave it out. Its rows pick the
 * answer as any parked card's do (`decision-rows.tsx`); Copy takes one
 * `jig send` command per target listed, and Send posts one answer per
 * target listed (`question-group-send.ts`). A guarded pick shows its check
 * panel once, naming every target it covers. The opened card shows each
 * target's own evidence: what was already done, and the reason.
 */
import { Send } from "lucide-react";
import { useRef } from "react";
import { needCard } from "./cards.ts";
import { CopyButton } from "./copy.tsx";
import { DecisionRows } from "./decision-rows.tsx";
import { InlineDecisionText } from "./decision-text.tsx";
import { Evidence } from "./fold.tsx";
import { useKeptToken } from "./forge-token.ts";
import { GutterCard } from "./gutter.tsx";
import { ActPill, BareWord, Glyph } from "./icon-word.tsx";
import { CARD_ICONS, CAUSE_ICONS, iconOf } from "./icons.ts";
import { cardAttrs } from "./keys.ts";
import { Mark } from "./marks.tsx";
import type { NeedView } from "./needs-view.ts";
import { OptionText } from "./option-text.tsx";
import { isGroupCommit, type TargetCommit } from "./question-group-commit.ts";
import {
  type GroupSending,
  type TargetOutcome,
  useGroupCard,
  useGroupSend,
} from "./question-group-send.ts";
import type { GroupMember, QuestionGroupView } from "./question-group-view.ts";
import { useSentHere } from "./sent.ts";
import { disarmOnLeave, type Picking, usePicking } from "./use-picking.ts";

/** What the line says the tick did with a target's answer. */
function actedWords(member: GroupMember): string | null {
  const [a] = member.acted;
  if (a === undefined) return null;
  const did =
    a.outcome === "done"
      ? "carried out"
      : a.outcome === "held"
        ? "held"
        : a.outcome === "refused"
          ? "refused"
          : "the tick is carrying it out";
  return `${a.author} chose ${a.option}: ${did}${a.detail === null ? "." : ` — ${a.detail}`}`;
}

/** What a target's row says of its answer: the tick's outcome, else this page's send, else an earlier send from this browser. */
function targetWords(
  member: GroupMember,
  outcome: TargetOutcome | undefined,
  sent: boolean,
): { text: string; fault: boolean } | null {
  const acted = actedWords(member);
  if (acted !== null) return { text: acted, fault: false };
  if (outcome?.kind === "refused")
    return {
      text: `Not sent: ${outcome.reason}${outcome.uncertain ? " It may have posted: open it and check before listing it again." : ""}`,
      fault: true,
    };
  if (outcome?.kind === "not attempted")
    return { text: `Not sent: ${outcome.reason}.`, fault: false };
  return outcome?.kind === "sent" || sent
    ? { text: "Sent here; the next tick reads it.", fault: false }
    : null;
}

/** What became of a target's answer, and whether it is left out. */
function TargetState({
  member,
  outcome,
  listed,
}: {
  member: GroupMember;
  outcome: TargetOutcome | undefined;
  listed: boolean;
}) {
  const sent = useSentHere(member.repo, member.target) !== null;
  const said = targetWords(member, outcome, sent);
  return (
    <>
      {said === null ? null : (
        <span
          className={`sm ${said.fault ? "decFault" : "mut"} groupTargetState`}
        >
          {said.text}
        </span>
      )}
      {listed ? null : (
        <span className="sm mut groupTargetLeft">Left out: it stays open.</span>
      )}
    </>
  );
}

/** The targets the card covers, each with a box that leaves it out of the answer. */
function GroupTargets({
  group,
  left,
  toggle,
  outcomes,
}: {
  group: QuestionGroupView;
  left: ReadonlySet<string>;
  toggle: (rowKey: string) => void;
  outcomes: ReadonlyMap<string, TargetOutcome>;
}) {
  return (
    <ul className="groupTargets">
      {group.members.map((m) => {
        const listed = !left.has(m.rowKey);
        return (
          <li
            className="groupTarget"
            key={m.rowKey}
            data-group-target={m.rowKey}
          >
            <label className="groupPick">
              <input
                type="checkbox"
                checked={listed}
                aria-label={`Answer ${m.repo} ${m.target}`}
                onChange={() => toggle(m.rowKey)}
              />
            </label>
            {m.url === null ? (
              <span className="m">{m.target}</span>
            ) : (
              <a
                className="m"
                href={m.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {m.target}
              </a>
            )}{" "}
            <span className="sm mut">{m.repo}</span>{" "}
            {m.title === null ? null : <span className="sm">{m.title}</span>}{" "}
            <span className="m sm mut nowrap">{m.age}</span>{" "}
            <TargetState
              member={m}
              outcome={outcomes.get(m.rowKey)}
              listed={listed}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The targets the card's answer covers now, each with its own answer. */
function targetsOf(picking: Picking): TargetCommit[] {
  return isGroupCommit(picking.commit) ? picking.commit.perTarget : [];
}

/** Where a target's answer goes, as the check panel names it. */
function destination(m: GroupMember): string {
  return "to" in m.send
    ? `${m.send.to.repo} #${m.send.to.number}`
    : `${m.repo} ${m.target}`;
}

/** The check panel, once for the card: each guarded pick with every target it covers, and, for Send, where each answer goes. */
function GroupGuard({
  need,
  picking,
  sending,
}: {
  need: NeedView;
  picking: Picking;
  sending: GroupSending | null;
}) {
  const { commit } = picking;
  const perTarget = targetsOf(picking);
  const send = picking.confirming === "send" ? sending : null;
  const covered = perTarget.map((t) => t.member.target).join(", ");
  return (
    <div className="guard" role="alert">
      <p className="sm">
        {send === null
          ? "A pick here asks for authorization or cannot be undone. Read what it does before you copy:"
          : `Send this answer to each of ${perTarget.length} targets as ${send.login}, one comment on each?`}
      </p>
      {send === null ? null : (
        <pre className="sm sendPreview">
          {perTarget
            .map((t) => `${destination(t.member)}\n${t.commit.text}`)
            .join("\n\n")}
        </pre>
      )}
      <ul className="sm">
        {commit.guarded.map((g) => {
          const row = need.rows[g.place - 1];
          const reason =
            g.option.reversible === false
              ? "This option cannot be undone."
              : row?.act === "Authorize"
                ? "This decision asks for authorization."
                : "This decision class requires confirmation.";
          return (
            <li key={g.key}>
              <p>
                <InlineDecisionText
                  source={row?.question ?? g.key}
                  links={false}
                />
              </p>
              <OptionText option={g.option} />
              <p>{reason}</p>
              <p className="groupCovers">Covers: {covered}</p>
            </li>
          );
        })}
      </ul>
      <div className="copyRow">
        {send === null ? (
          <CopyButton
            text={commit.text}
            idle="Confirm copy"
            aria={`Confirm and copy the jig send commands for ${need.target}`}
            label="Confirm copy"
            gate={picking.gate}
          />
        ) : (
          <GroupSendButton need={need} sending={send} confirm />
        )}
        <button type="button" className="fbtn" onClick={picking.disarm}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function GroupSendButton({
  need,
  sending,
  confirm = false,
}: {
  need: NeedView;
  sending: GroupSending;
  confirm?: boolean;
}) {
  const aria = `${confirm ? "Confirm and send" : "Send"} the answers for ${need.target} as ${sending.login}`;
  return (
    <button
      type="button"
      className="copy send"
      aria-label={aria}
      title={sending.ready ? aria : "Pick an option to send"}
      aria-disabled={sending.sending || !sending.ready}
      onClick={sending.send}
    >
      <Send size={14} aria-hidden="true" />
      <span className="copyLabel">
        {sending.sending
          ? "Sending…"
          : confirm
            ? "Confirm send"
            : "Send the answers"}
      </span>
    </button>
  );
}

/** The card's count, Copy, Send and Undo, why a listed target holds Send back, and the check panel. */
function GroupControls({
  need,
  picking,
  sending,
}: {
  need: NeedView;
  picking: Picking;
  sending: GroupSending | null;
}) {
  const { kept } = useKeptToken();
  const { commit } = picking;
  const perTarget = targetsOf(picking);
  const total = need.group?.members.length ?? 0;
  const noSend = perTarget.filter((t) => !("to" in t.member.send));
  return (
    <>
      <span className="sm mut decCount">
        {perTarget.length} of {total} listed · {commit.picked} picked here
      </span>
      <CopyButton
        text={commit.text}
        idle="Copy the send commands"
        aria={`Copy the jig send commands for ${need.target}`}
        label="Copy the send commands"
        gate={picking.gate}
      />
      {sending === null ? null : (
        <GroupSendButton need={need} sending={sending} />
      )}
      {picking.answers.some((a) => a.pick !== null) ? (
        <button type="button" className="fbtn" onClick={picking.undo}>
          <Glyph of={CARD_ICONS.undo} />
          Undo last pick
        </button>
      ) : null}
      {picking.confirming === null ? null : (
        <GroupGuard need={need} picking={picking} sending={sending} />
      )}
      {noSend.map((t) => (
        <p className="sm mut noSend" key={t.member.rowKey}>
          {t.member.repo} {t.member.target}:{" "}
          {"absent" in t.member.send ? t.member.send.absent : ""} Leave it out
          to send the rest.
        </p>
      ))}
      {kept === null ? (
        <p className="sm mut noSend">
          Paste a GitHub token to send from this browser: open “Send from here”
          above, then Test and keep.
        </p>
      ) : null}
    </>
  );
}

/** What the opened card shows: the steps for a person, then each target's own evidence. */
function GroupDetail({ need }: { need: NeedView }) {
  return (
    <>
      {need.steps.length === 0 ? null : (
        <div className="steps">
          <h3>Steps for you, for each target</h3>
          <ul>
            {need.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      )}
      {need.group?.members.map((m) => (
        <div className="groupEvidence" key={m.rowKey}>
          <h3>
            {m.repo} {m.target}
          </h3>
          {m.concluded === null ? null : (
            <p className="sm mut concluded">The run concluded: {m.concluded}</p>
          )}
          {m.alreadyDone.map((text) => (
            <p className="sm" key={text}>
              Already done: {text}
            </p>
          ))}
          <Evidence
            rows={[
              { k: "cause", v: m.recorded },
              { k: "reason", v: m.reason, copy: m.reason },
              ...m.evidence,
            ]}
          />
        </div>
      ))}
    </>
  );
}

export function GroupNeedItem({
  need,
  rest,
  facets,
}: {
  need: NeedView;
  rest: boolean;
  facets: Record<string, string>;
}) {
  const card = useRef<HTMLElement | null>(null);
  const group = need.group as QuestionGroupView;
  const { left, toggle, outcomes } = useGroupCard(group.id);
  const picking = usePicking(need, card, left);
  const sending = useGroupSend(need, picking);
  const attrs = {
    ...cardAttrs({ ...needCard(need, picking.commit), picks: true }),
    "data-question-group": group.id,
    "data-needs": String(group.members.length),
  };
  return (
    <GutterCard
      className={rest ? "need groupCard groupRest" : "need groupCard"}
      cardRef={card}
      attrs={{ ...attrs, ...facets }}
      label={`Each target's evidence for ${need.target}`}
      onBlur={disarmOnLeave(picking)}
      face={
        <>
          <div className="rowTop">
            <ActPill act={need.act} />
            <Mark role={need.role} />
            <span className="m groupSize">{need.target}</span>
            <span className="sm mut">, one question</span>
            <span className="m sm mut end nowrap">{need.age}</span>
          </div>
          <DecisionRows need={need} picking={picking} />
          <GroupTargets
            group={group}
            left={left}
            toggle={toggle}
            outcomes={outcomes}
          />
          {need.people.length === 0 ? null : (
            <p className="sm waitsOn">
              Waits on <span className="m">{need.people.join(", ")}</span>
            </p>
          )}
          <div className="sm">
            <BareWord of={iconOf(CAUSE_ICONS, need.cause)} className="m">
              {need.recorded}
            </BareWord>
            <span className="mut">{need.classNote}</span>
          </div>
          <div className="goto">
            <GroupControls need={need} picking={picking} sending={sending} />
          </div>
        </>
      }
      detail={<GroupDetail need={need} />}
    />
  );
}
