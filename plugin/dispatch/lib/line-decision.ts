/** Typed parks and the legacy framed text a tick turns into a card's decision. */
import type { LineDecision } from "./dashboard-contract.ts";
import { optionDetails } from "../../shared/decisions/model.ts";
import {
  renderParkedDecision,
  type ParkedDecision,
} from "../../shared/decisions/park.ts";
import {
  recordOptions,
  recordSteps,
} from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";

/** The heading the drive prints above a framed decision: its kind, key, class and round. */
const FRAME_HEAD = /^\[[a-z]+\] \S+ · class (\S.*?) · parked at round \d+$/;

/** The lines under a `## ` heading of a decision record, up to the next heading; `null` when it has none. */
function sectionLines(lines: string[], heading: string): string[] | null {
  const from = lines.indexOf(`## ${heading}`);
  if (from < 0) return null;
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The text under a `## ` heading of a decision record, on one line. */
function section(lines: string[], heading: string): string | null {
  const body = (sectionLines(lines, heading) ?? [])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return body === "" ? null : body;
}

/**
 * A parked decision from the lines the drive printed: the frame's heading goes
 * into the fields, and the record under it, which is Markdown indented two
 * spaces, loses the indent.
 */
export function decisionOf(park: {
  digest?: string;
  parkedAt?: string;
  decision?: ParkedDecision;
  person?: string;
  key: string;
  kind: "thread" | "finding";
  lines: string[];
}): LineDecision {
  const identity = {
    key: park.key,
    kind: park.kind,
    ...(park.digest === undefined ? {} : { digest: park.digest }),
    ...(park.parkedAt === undefined ? {} : { parkedAt: park.parkedAt }),
    ...(park.person === undefined ? {} : { person: park.person }),
  };
  if (park.decision !== undefined) {
    const decision = park.decision;
    const call = decision.call;
    const chosen = call.options.find((o) => o.id === call.recommended);
    return {
      ...identity,
      decision,
      lines: renderParkedDecision(decision).split("\n"),
      question: call.question ?? null,
      recommendation:
        chosen === undefined ? null : `${chosen.name}: ${call.why ?? ""}`,
      decisionClass: decision.class,
      options: call.options.map((o) => ({
        name: o.name,
        changes: o.summary,
        costs: o.pay.join("\n"),
        recommended: o.id === call.recommended,
        details: optionDetails(o),
      })),
      steps: decision.steps,
    };
  }
  const [head, ...record] = park.lines;
  const framed = head === undefined ? null : FRAME_HEAD.exec(head);
  const lines = (framed === null ? park.lines : record).map((l) =>
    l.startsWith("  ") ? l.slice(2) : l,
  );
  const named = framed?.[1];
  const recommendation = section(lines, "Recommended");
  const steps = sectionLines(lines, "Steps for a person");
  return {
    ...identity,
    lines,
    question: section(lines, "Question"),
    recommendation,
    decisionClass:
      named === undefined || named === "(none recorded)" ? null : named,
    options: recordOptions(
      (sectionLines(lines, "Options") ?? []).join("\n"),
      recommendation,
    ),
    steps: steps === null ? [] : recordSteps(steps.join("\n")),
  };
}
