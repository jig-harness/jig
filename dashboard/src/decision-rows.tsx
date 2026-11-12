/**
 * A parked need's decisions, one short row each: the question, its act where
 * it differs from the card's, how it bears on another decision, the
 * recommended option and the pick. The other options fold under the row. On
 * a phone each option is a row to tap and no number is shown; with keys, the
 * number picks it (`use-picking.ts`). Below the rows: how many are picked,
 * Copy and, where a token is kept, Send (`send.tsx`), each taking a second
 * step for a guarded pick, and Undo.
 */
import { useId, useState } from "react";
import { CopyButton } from "./copy.tsx";
import { InlineDecisionText } from "./decision-text.tsx";
import type { NeedView } from "./needs-view.ts";
import { OptionText } from "./option-text.tsx";
import type { DecisionRow, RowAnswer, RowOption } from "./picking.ts";
import { SendButton, SendSaid, useSend } from "./send.tsx";
import type { Field, Picking } from "./use-picking.ts";

function OptionPick({
  option,
  picked,
  onPick,
}: {
  option: RowOption;
  picked: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`opt${option.recommended ? " rec" : ""}${picked ? " on" : ""}`}
        aria-pressed={picked}
        onClick={onPick}
      >
        <kbd className="optNum">{option.number}</kbd>
        <span className="optMark" aria-hidden="true">
          {picked ? "●" : "○"}
        </span>
        <span className="optText">
          <OptionText option={option} />
          {option.recommended ? " (recommended)" : ""}
          {option.guarded ? (
            <span className="mut"> · copying it takes a second step</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** What a row's answer is now, in words: what counts, what is only a draft, and what was dropped or cannot be sent. */
function AnswerState({ answer }: { answer: RowAnswer }) {
  // A row whose answer cannot be sent says only why, never that it counts.
  const draft =
    answer.fault !== null
      ? null
      : answer.active === "pick" && answer.free.trim() !== ""
        ? "Your pick counts; your own words are kept as a draft."
        : answer.active === "free" && answer.pick !== null
          ? "Your own words count; the pick is kept as a draft."
          : null;
  return (
    <>
      {answer.dropped === null ? null : (
        <p className="sm decNote">{answer.dropped}</p>
      )}
      {draft === null ? null : <p className="sm mut">{draft}</p>}
      {answer.fault === null ? null : (
        <p className="sm decFault">Not copied: {answer.fault}</p>
      )}
    </>
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
  if (!several && !ownAct) return null;
  return (
    <div className="decHead sm">
      {several ? (
        <span className="m mut">
          {row.place} of {need.rows.length}
        </span>
      ) : null}
      {ownAct ? <span className={`act act${row.act}`}>{row.act}</span> : null}
      {row.decisionClass === null ? null : (
        <span className="mut">{row.decisionClass}</span>
      )}
    </div>
  );
}

/** The options of a decision the drive reads every answer to as free: shown, not pickable. */
function UnpickableOptions({ row }: { row: DecisionRow }) {
  return (
    <>
      <ul className="opts">
        {row.options.map((o) => (
          <li key={o.name}>
            <span className="optText">
              <OptionText option={o} />
            </span>
          </li>
        ))}
      </ul>
      <p className="sm mut">
        The drive reads every answer to this decision as your own words, so
        these options cannot be picked; write the answer.
      </p>
    </>
  );
}

/** The recommended option and the pick in sight, the other options behind a fold. */
function RowOptions({ row, index, picking }: Omit<RowProps, "need">) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const picked = picking.answers[index]?.pick?.name ?? null;
  const [first, ...rest] = row.options;
  const shown = row.options.filter((o) => o === first || o.name === picked);
  const folded = rest.filter((o) => o.name !== picked);
  if (!row.structured) return <UnpickableOptions row={row} />;
  const list = (options: RowOption[]) =>
    options.map((o) => (
      <OptionPick
        key={o.name}
        option={o}
        picked={o.name === picked}
        onPick={() => picking.pick(index, o)}
      />
    ));
  const more = `${folded.length} other option${folded.length === 1 ? "" : "s"}`;
  return (
    <>
      {shown.length === 0 ? null : <ul className="opts">{list(shown)}</ul>}
      {folded.length === 0 ? null : (
        <button
          type="button"
          className="foldBtn optsMore"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide the other options" : more}
        </button>
      )}
      {open && folded.length > 0 ? (
        <ul className="opts options" id={id}>
          {list(folded)}
        </ul>
      ) : null}
    </>
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
      {question === null ? null : <p className="q">{question}</p>}
      {row.interplay.map((text) => (
        <p className="sm mut interplay" key={text}>
          With another decision: {text}
        </p>
      ))}
      {row.recommendation === null ? null : (
        <p className="sm mut">
          <InlineDecisionText source={`Recommended: ${row.recommendation}`} />
        </p>
      )}
      <RowOptions row={row} index={index} picking={picking} />
      <AnswerState answer={answer} />
      <RowWords row={row} index={index} picking={picking} />
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
  const { commit } = picking;
  const total = need.rows.length;
  const words = commit.free === 0 ? "" : ` · ${commit.free} in your own words`;
  return (
    <div className="decs">
      <p className="sm mut decCount">
        {total} decision{total === 1 ? "" : "s"} · {commit.picked} picked
        {words}
      </p>
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

/** The card's Copy, Send and Undo, and, once Copy or Send is pressed with a guarded pick, what it would approve. */
export function CommitControls({
  need,
  picking,
}: {
  need: NeedView;
  picking: Picking;
}) {
  const { commit, confirming } = picking;
  const what = COPY_WORDS[commit.label];
  const anyPick = picking.answers.some((a) => a.pick !== null);
  const sending = useSend(need, picking);
  return (
    <>
      <CopyButton
        text={commit.text}
        idle={`Copy ${what}`}
        aria={`Copy ${what} for ${need.target}`}
        label={commit.label === "answer line" ? undefined : `Copy ${what}`}
        gate={picking.gate}
      />
      {sending === null ? null : (
        <SendButton
          need={need}
          sending={sending}
          what={commit.label === "answer line" ? "the answers" : what}
        />
      )}
      {anyPick ? (
        <button type="button" className="fbtn" onClick={picking.undo}>
          Undo last pick
        </button>
      ) : null}
      {confirming === null ? null : (
        <div className="guard" role="alert">
          <p className="sm">
            A pick here asks for authorization or cannot be undone. Read what it
            does before you {confirming === "copy" ? "copy" : "send"}:
          </p>
          <ul className="sm">
            {commit.guarded.map((g) => (
              <li key={g.key}>
                {need.rows.length > 1
                  ? `${g.place} of ${need.rows.length}: `
                  : ""}
                <OptionText option={g.option} />
              </li>
            ))}
          </ul>
          <div className="copyRow">
            {confirming === "send" && sending !== null ? (
              <SendButton need={need} sending={sending} what={what} confirm />
            ) : (
              <CopyButton
                text={commit.text}
                idle="Confirm copy"
                aria={`Confirm and copy the answers for ${need.target}`}
                label="Confirm copy"
                gate={picking.gate}
              />
            )}
            <button type="button" className="fbtn" onClick={picking.disarm}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {sending === null ? null : (
        <SendSaid need={need} sending={sending} text={commit.text} />
      )}
    </>
  );
}
