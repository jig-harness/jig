/**
 * What a run's closing report says on the page, as a pure function of its
 * ended row (`EndedRow`, whose report fields `closing-report-store.ts`
 * writes): what the run concluded, the next step its writer suggests, why it
 * fell short and who wrote it. A run that ended `by: none` reads as "ended
 * without a report". Where the suggested next step's owner and the tick's
 * own `next` differ, both are shown, and nothing decides between them.
 */
import type { EndedRow } from "../../plugin/dispatch/lib/log.ts";
import type { NextOwner } from "../../plugin/dispatch/lib/next-owner.ts";
import type { SuggestedNext } from "../../plugin/shared/closing-report.ts";
import type { EvidenceRow } from "./view.ts";

/** What a run that left no report says in place of one. */
export const NO_REPORT = "Ended without a report";

export interface RunReportView {
  /** Who wrote the report: `agent`, `driver`, `wrapper`, `steward`, `person`, or `none`. */
  by: string;
  /** Whether the run left no report. */
  missing: boolean;
  /** What the run concluded, in its writer's words; `null` without a report. */
  concluded: string | null;
  /** The next step its writer suggests, with who takes it; `null` without a report. */
  suggested: string | null;
  /** Why the run fell short; `null` when the report names no cause. */
  cause: string | null;
  /** The tick's own next owner, where it differs from the suggested one; `null` where they agree or either is missing. */
  tickNext: string | null;
  /** The report on one line, as the run's line shows it. */
  line: string;
  /** The report's fields, for the opened row. */
  evidence: EvidenceRow[];
}

/** `watch the drive (line)`, `merge it (person, Merge)`. */
function suggestedText(next: SuggestedNext): string {
  const owner =
    next.owner === "person" && next.act !== undefined
      ? `person, ${next.act}`
      : next.owner;
  return `${next.step} (${owner})`;
}

/** The tick's next owner in the words `jig ask` prints it with. */
function tickNextText(next: NextOwner): string {
  if ("address" in next) return next.address;
  if ("person" in next) return `person: ${next.person} — ${next.act}`;
  return `none: ${next.none}`;
}

/** Who a tick's next owner is, in the report's terms: a station of the line, a person, or nobody. */
function ownerOf(next: NextOwner): SuggestedNext["owner"] {
  if ("address" in next) return "line";
  return "person" in next ? "person" : "none";
}

/** The tick's next owner where it names another owner than the report's suggestion. */
function differingNext(row: EndedRow): string | null {
  const suggested = row.suggested_next;
  const next = row.next ?? null;
  if (suggested === undefined || next === null) return null;
  return ownerOf(next) === suggested.owner ? null : tickNextText(next);
}

/** The labelled fields that are present, in the order the page shows them. */
function present(fields: Array<[string, string | null]>): EvidenceRow[] {
  return fields.flatMap(([k, v]) => (v === null ? [] : [{ k, v }]));
}

/** A run that ended without a report, with the cause another writer recorded, if any. */
function missingReport(cause: string | null): RunReportView {
  return {
    by: "none",
    missing: true,
    concluded: null,
    suggested: null,
    cause,
    tickNext: null,
    line: cause === null ? NO_REPORT : `${NO_REPORT} · cause: ${cause}`,
    evidence: present([
      ["report", "none"],
      ["cause", cause],
    ]),
  };
}

/** A row's report as the page shows it; `null` for a row from before reports were kept. */
export function runReport(row: EndedRow): RunReportView | null {
  const by = row.by;
  if (by === undefined) return null;
  const cause = row.cause ?? null;
  if (by === "none") return missingReport(cause);
  const concluded = row.concluded ?? null;
  const suggested =
    row.suggested_next === undefined ? null : suggestedText(row.suggested_next);
  const tickNext = differingNext(row);
  const shown = present([
    ["concluded", concluded],
    ["suggested next", suggested],
    ["tick's next", tickNext],
    ["cause", cause],
  ]);
  const said: Record<string, string> = {
    concluded: "",
    "suggested next": "next: ",
    "tick's next": "the tick reads next: ",
    cause: "cause: ",
  };
  return {
    by,
    missing: false,
    concluded,
    suggested,
    cause,
    tickNext,
    line: shown.map((f) => `${said[f.k] ?? ""}${f.v}`).join(" · "),
    evidence: [...shown, { k: "report by", v: by }],
  };
}
