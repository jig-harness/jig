import { answerId, useAnswers } from "./answers.ts";
import type { NeedRow } from "./needs-view.ts";
import { rowAnswer } from "./picking.ts";

export function groupMembers(rows: NeedRow[], index: number): NeedRow[] {
  const next = rows.findIndex((row, at) => at > index && row.type === "head");
  return rows.slice(index + 1, next === -1 ? rows.length : next);
}

export function DecisionCounts({ rows }: { rows: NeedRow[] }) {
  const decisions = rows.flatMap((row) =>
    row.type === "need"
      ? row.need.rows.map((decision) => ({
          decision,
          id: answerId(row.need.repo, row.need.target, decision.key),
        }))
      : [],
  );
  const [kept] = useAnswers(decisions.map(({ id }) => id));
  if (decisions.length === 0) return null;
  const answers = decisions.map(({ decision }, index) =>
    rowAnswer(decision, kept[index] ?? null),
  );
  const counts = [
    ["picked", answers.filter((answer) => answer.active === "pick").length],
    ["own words", answers.filter((answer) => answer.active === "free").length],
    ["with a note", answers.filter((answer) => answer.note.trim()).length],
    [
      "draft",
      answers.filter(
        (answer) => answer.pick !== null && answer.free.trim() !== "",
      ).length,
    ],
    [
      "guarded",
      answers.filter(
        (answer) => answer.active === "pick" && answer.pick?.guarded,
      ).length,
    ],
    ["dropped", answers.filter((answer) => answer.dropped !== null).length],
    ["held back", answers.filter((answer) => answer.fault !== null).length],
  ] as const;
  const notes = rows.flatMap((row) =>
    row.type === "need" ? row.need.answerNotes : [],
  );
  return (
    <span className="sm mut">
      {decisions.length} decision{decisions.length === 1 ? "" : "s"}
      {(["stale", "disputed", "from the line"] as const).map((state) => {
        const count = notes.filter((note) => note.state === state).length;
        return count === 0 ? null : (
          <span key={state}>
            {" "}
            · {count} {state}
          </span>
        );
      })}
      {counts
        .filter(([name, count]) => name === "picked" || count > 0)
        .map(([name, count]) => (
          <span key={name}>
            {" "}
            · {count} {name} here
          </span>
        ))}
    </span>
  );
}

export function filterAnswerStates(rows: NeedRow[], state: string): NeedRow[] {
  if (state === "any") return rows;
  const matches = (row: NeedRow) =>
    row.type === "need" &&
    row.need.answerNotes.some((note) => note.state === state);
  return rows.filter((row, index) =>
    row.type === "head"
      ? groupMembers(rows, index).some(matches)
      : matches(row),
  );
}
