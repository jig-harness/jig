/** An option as a card reads it: its name in bold, then what it changes and costs, then its details. */
import type { LineOption } from "../../plugin/dispatch/lib/dashboard-contract.ts";

import { InlineDecisionText } from "./decision-text.tsx";

/** A clause without the full stop or semicolon the record ends it with, so two can share one sentence. */
function clause(text: string): string {
  return text.replace(/[.;]\s*$/, "");
}

export function OptionText({ option }: { option: LineOption }) {
  return (
    <>
      <strong>
        <InlineDecisionText source={option.name} links={false} />
      </strong>
      {option.changes === null ? null : (
        <>
          {" "}
          — changes:{" "}
          <InlineDecisionText source={clause(option.changes)} links={false} />
        </>
      )}
      {option.costs === null ? null : (
        <>
          ; costs:{" "}
          <InlineDecisionText source={clause(option.costs)} links={false} />
        </>
      )}
      {(option.details ?? []).map((detail) => (
        <span key={detail.label}>
          ; {detail.label}:{" "}
          <InlineDecisionText source={detail.text} links={false} />
        </span>
      ))}
    </>
  );
}
