/**
 * A parked need's decisions, one short row each: the question, its act where
 * it differs from the card's, how it bears on another decision, the
 * recommended option and the pick. The other options fold under the row. On
 * a phone each option is a row to tap and no number is shown; with keys, the
 * number picks it (`use-picking.ts`). Below the rows: how many are picked,
 * Copy and, where a token is kept, Send (`send.tsx`), each taking a second
 * step for a guarded pick, and Undo.
 */
import { CopyButton } from "./copy.tsx";
import { InlineDecisionText } from "./decision-text.tsx";
import { answerCommentUrl } from "./keys.ts";
import { ActPill, BareWord, Glyph } from "./icon-word.tsx";
import { CARD_ICONS, HERE_ICONS } from "./icons.ts";
import type { NeedView } from "./needs-view.ts";
import { OptionText } from "./option-text.tsx";
import type { DecisionRow, RowAnswer, RowOption } from "./picking.ts";
import { SendButton, SendSaid, type Sending, useSend } from "./send.tsx";
import type { Field, Picking } from "./use-picking.ts";

function OptionPick({
  option,
  picked,
  onPick,
  expandedOnly,
}: {
  option: RowOption;
  picked: boolean;
  onPick: () => void;
  expandedOnly: boolean;
}) {
  return (
    <li className={expandedOnly ? "decExpanded" : undefined}>
      <button
        type="button"
        className={`opt${option.recommended ? " rec" : ""}${picked ? " on" : ""}`}
        aria-pressed={picked}
        onClick={onPick}
      >
        <kbd className="optNum">{option.number}</kbd>
        <span className="optMark" aria-hidden="true">
          <Glyph of={HERE_ICONS[picked ? "picked" : "unpicked"]} />
        </span>
        <span className="optText">
          <OptionText option={option} />
          {option.recommended ? " (recommended)" : ""}
          {option.guarded ? (
            <span className="mut">
              {" · "}
              <BareWord of={HERE_ICONS.guarded}>
                copying it takes a second step
              </BareWord>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** The state of the answer kept in this browser. */
function answerState(
  answer: RowAnswer,
): { kind: keyof typeof HERE_ICONS; text: string } | null {
  if (answer.fault !== null)
    return { kind: "held back", text: `Not copied: ${answer.fault}` };
  if (answer.dropped !== null)
    return {
      kind: "dropped",
      text:
        answer.active === "free"
          ? `${answer.dropped} Your own words still count.`
          : answer.dropped,
    };
  if (answer.active === "free")
    return answer.pick === null
      ? { kind: "own words", text: "Your own words count." }
      : {
          kind: "draft",
          text: "Your own words count; the pick is kept as a draft.",
        };
  if (answer.pick === null) return null;
  if (answer.free.trim())
    return {
      kind: "draft",
      text: "Your pick counts; your own words are kept as a draft.",
    };
  if (answer.pick.guarded)
    return { kind: "guarded", text: "Picked · confirm before copying" };
  if (answer.note.trim()) return { kind: "note", text: "Picked · with a note" };
  return { kind: "picked", text: "Picked" };
}

function AnswerState({ answer }: { answer: RowAnswer }) {
  const state = answerState(answer);
  return state === null ? null : (
    <p className={`sm ${answer.fault === null ? "decNote" : "decFault"}`}>
      <BareWord of={HERE_ICONS[state.kind]}>{state.text}</BareWord>
    </p>
  );
}

const FIELD_WORDS: Record<Field, { label: string; hint: string }> = {
  note: {
    label: "Note beside your pick",
    hint: "One line that narrows the option, such as a condition",
  },
  free: {
    label: "Your own words",
    hint: "One line, such as an option and why",
  },
};

function WordsField({
  row,
  field,
  value,
  onChange,
  onLeave,
}: {
  row: DecisionRow;
  field: Field;
  value: string;
  onChange: (text: string) => void;
  onLeave: () => void;
}) {
  return (
    <label className="reply">
      <span className="sm mut">
        {FIELD_WORDS[field].label} for <span className="m">{row.key}</span>
      </span>
      <input
        type="text"
        data-field={`${row.key} ${field}`}
        value={value}
        placeholder={FIELD_WORDS[field].hint}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" && event.key !== "Enter") return;
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          onLeave();
          event.currentTarget.closest<HTMLElement>("[data-card]")?.focus();
        }}
      />
    </label>
  );
}

/** What a row is told: its decision, its place, and the card's picking. */
interface RowProps {
  need: NeedView;
  row: DecisionRow;
  index: number;
  picking: Picking;
}

/** The row's place on the card, its act where it differs from the card's, and its class. */
function DecisionHead({ need, row }: { need: NeedView; row: DecisionRow }) {
  const several = need.rows.length > 1;
  const ownAct = row.act !== need.act;
  if (
    !several &&
    !ownAct &&
    row.decisionClass === null &&
    row.interplay.length === 0
  )
    return null;
  return (
    <div className="decHead sm">
      {several ? (
        <span className="m mut">
          {row.place} of {need.rows.length}
        </span>
      ) : null}
      {ownAct ? <ActPill act={row.act} /> : null}
      {row.decisionClass === null ? null : (
        <span className="mut">{row.decisionClass}</span>
      )}
      {row.interplay.map((text) => (
        <span className="interplay" key={text}>
          <BareWord of={CARD_ICONS.interplay}>
            With another decision: {text}
          </BareWord>
        </span>
      ))}
    </div>
  );
}

/** The options of a decision the drive reads every answer to as free: shown, not pickable. */
function UnpickableOptions({ row }: { row: DecisionRow }) {
  return (
    <>
      <ul className="opts">
        {row.options.map((o) => (
          <li
            key={o.name}
            className={o.recommended ? undefined : "decExpanded"}
          >
            <span className="optText">
              <OptionText option={o} />
            </span>
          </li>
        ))}
      </ul>
      <p className="sm mut decExpanded">
        The drive reads every answer to this decision as your own words, so
        these options cannot be picked; write the answer.
      </p>
    </>
  );
}

/** The recommended option and the pick in sight, the other options on the open card. */
function RowOptions({ row, index, picking }: Omit<RowProps, "need">) {
  const picked = picking.answers[index]?.pick?.name ?? null;
  if (!row.structured) return <UnpickableOptions row={row} />;
  if (row.options.length === 0) return null;
  return (
    <ul className="opts">
      {row.options.map((option) => (
        <OptionPick
          key={option.name}
          option={option}
          picked={option.name === picked}
          expandedOnly={!option.recommended && option.name !== picked}
          onPick={() => picking.pick(index, option)}
        />
      ))}
    </ul>
  );
}

/** Whether a row's note or own-words field shows: opened, or holding words. */
function fieldShown(
  picking: Picking,
  row: DecisionRow,
  answer: RowAnswer,
  field: Field,
): boolean {
  const opened =
    picking.editing?.key === row.key && picking.editing.field === field;
  const words = field === "note" ? answer.note : answer.free;
  return opened || words.trim() !== "";
}

/** The row's buttons and fields: clear the pick, a note beside it, an answer in the person's own words. */
function RowWords({ row, index, picking }: Omit<RowProps, "need">) {
  const answer = picking.answers[index] ?? null;
  if (answer === null) return null;
  const picked = answer.pick !== null;
  const note = picked && fieldShown(picking, row, answer, "note");
  const free = fieldShown(picking, row, answer, "free");
  const words = (field: Field, value: string) => (
    <WordsField
      row={row}
      field={field}
      value={value}
      onChange={(text) => picking.setText(index, field, text)}
      onLeave={picking.closeField}
    />
  );
  return (
    <>
      <div className="decTools">
        {picked ? (
          <button
            type="button"
            className="fbtn"
            onClick={() => picking.clear(index)}
          >
            Clear pick
          </button>
        ) : null}
        {picked && !note ? (
          <button
            type="button"
            className="fbtn"
            onClick={() => picking.openField(index, "note")}
          >
            Add a note
          </button>
        ) : null}
        {free ? null : (
          <button
            type="button"
            className="fbtn"
            onClick={() => picking.openField(index, "free")}
          >
            {picked ? "Answer in your words" : "Write an answer"}
          </button>
        )}
      </div>
      {note ? words("note", answer.note) : null}
      {free ? words("free", answer.free) : null}
    </>
  );
}

function DecisionRowView({ need, row, index, picking }: RowProps) {
  const answer = picking.answers[index];
  if (answer === undefined) return null;
  const current = picking.current === index && need.rows.length > 1;
  const question = row.question ?? (index === 0 ? need.question : null);
  return (
    <div
      className={current ? "dec cur" : "dec"}
      data-decision={row.key}
      aria-current={current ? "true" : undefined}
    >
      <DecisionHead need={need} row={row} />
      {question === null ? null : (
        <p className="q">
          <InlineDecisionText source={question} links={false} />
        </p>
      )}
      {row.recommendation === null ? null : (
        <p className="sm mut">
          <InlineDecisionText source={`Recommended: ${row.recommendation}`} />
        </p>
      )}
      <RowOptions row={row} index={index} picking={picking} />
      <AnswerState answer={answer} />
      <div className="decExpanded decFields">
        <RowWords row={row} index={index} picking={picking} />
      </div>
    </div>
  );
}

/** Every decision of a parked need, one row each, with what the card's Copy takes. */
export function DecisionRows({
  need,
  picking,
}: {
  need: NeedView;
  picking: Picking;
}) {
  return (
    <div className="decs">
      {need.rows.map((row, i) => (
        <DecisionRowView
          key={row.key}
          need={need}
          row={row}
          index={i}
          picking={picking}
        />
      ))}
      {picking.saved ? null : (
        <p className="sm mut">
          Not saved: this browser keeps nothing, so your picks and words last
          only while this page stays open. Copy them before leaving.
        </p>
      )}
    </div>
  );
}

/** What each label Copy carries says it copies. */
const COPY_WORDS = {
  answers: "the answers",
  approval: "the approval",
  "answer line": "the answer line",
} as const;

/** The check panel a guarded pick opens under the copy row: what each guarded pick does, then the commit's second step or Cancel. */
function GuardPanel({
  need,
  picking,
  sending,
}: {
  need: NeedView;
  picking: Picking;
  sending: Sending | null;
}) {
  const { commit, confirming } = picking;
  const send = confirming === "send" ? sending : null;
  return (
    <div className="guard" role="alert">
      <p className="sm">
        {send === null
          ? "A pick here asks for authorization or cannot be undone. Read what it does before you copy:"
          : `Send these answers to ${send.to.repo} #${send.to.number} as ${send.login}?`}
      </p>
      {send === null ? null : (
        <pre className="sm sendPreview">{commit.text}</pre>
      )}
      <ul className="sm">
        {commit.guarded.map((g) => {
          const row = need.rows[g.place - 1];
          const question = row?.question ?? g.key;
          const reason =
            g.option.reversible === false
              ? "This option cannot be undone."
              : row?.act === "Authorize"
                ? "This decision asks for authorization."
                : "This decision class requires confirmation.";
          return (
            <li key={g.key}>
              <p>
                <InlineDecisionText source={question} links={false} />
              </p>
              <OptionText option={g.option} />
              <p>{reason}</p>
            </li>
          );
        })}
      </ul>
      <div className="copyRow">
        {send === null ? (
          <CopyButton
            text={commit.text}
            idle="Confirm copy"
            aria={`Confirm and copy the answers for ${need.target}`}
            label="Confirm copy"
            gate={picking.gate}
          />
        ) : (
          <SendButton need={need} sending={send} confirm />
        )}
        <button type="button" className="fbtn" onClick={picking.disarm}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The card's Copy, Send and Undo, and, once Copy or Send is pressed with a guarded pick, what it would approve. */
export function CommitControls({
  need,
  picking,
}: {
  need: NeedView;
  picking: Picking;
}) {
  const { commit } = picking;
  const what = COPY_WORDS[commit.label];
  const anyPick = picking.answers.some((a) => a.pick !== null);
  const sending = useSend(need, picking);
  const commentUrl = answerCommentUrl(need.url);
  return (
    <>
      <span className="sm mut decCount">
        {need.rows.length} decision{need.rows.length === 1 ? "" : "s"} ·{" "}
        {commit.picked} picked here
      </span>
      <CopyButton
        text={commit.text}
        idle={`Copy ${what}`}
        aria={`Copy ${what} for ${need.target}`}
        label={commit.label === "answer line" ? undefined : `Copy ${what}`}
        gate={picking.gate}
      />
      {sending === null ? null : <SendButton need={need} sending={sending} />}
      {anyPick ? (
        <button type="button" className="fbtn" onClick={picking.undo}>
          <Glyph of={CARD_ICONS.undo} />
          Undo last pick
        </button>
      ) : null}
      {commentUrl !== null ? (
        <a
          className="fbtn"
          href={commentUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Paste in a pull request comment
        </a>
      ) : null}
      {picking.confirming === null ? null : (
        <GuardPanel need={need} picking={picking} sending={sending} />
      )}
      {sending === null ? null : (
        <SendSaid need={need} sending={sending} text={commit.text} />
      )}
    </>
  );
}
