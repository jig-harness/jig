/** An option as a card reads it: its name in bold, then what it changes and costs, then its details. */
import type { LineOption } from "../../plugin/dispatch/lib/dashboard-contract.ts";

/** A clause without the full stop or semicolon the record ends it with, so two can share one sentence. */
function clause(text: string): string {
  return text.replace(/[.;]\s*$/, "");
}

export function OptionText({ option }: { option: LineOption }) {
  return (
    <>
      <strong>{option.name}</strong>
      {option.changes === null ? null : (
        <> — changes: {clause(option.changes)}</>
      )}
      {option.costs === null ? null : <>; costs: {clause(option.costs)}</>}
      {(option.details ?? []).map((detail) => (
        <span key={detail.label}>
          ; {detail.label}: {detail.text}
        </span>
      ))}
    </>
  );
}
