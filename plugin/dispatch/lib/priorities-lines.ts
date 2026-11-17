/**
 * The priorities part of a repository's report as a person reads it: the
 * record the ranking used, the weights file's problems, each weighted lane's
 * share beside its starts this week, the floor owed, the shortlist, and what
 * dispatch actually started this tick beside it. Report only: dispatch's
 * selection does not read the shortlist.
 */
import type { RepoReport } from "./types.ts";

/** How many shortlist positions the report shows. */
const SHOWN = 10;

export function priorityLines(r: RepoReport, verb: string): string[] {
  const p = r.priorities;
  if (p === undefined) return [];
  if ("failed" in p) return [`  priorities ${p.failed}`];
  const lines: string[] = [];
  const rev =
    p.record.revision === null ? "" : `, revision ${p.record.revision}`;
  lines.push(`  priorities record ${p.record.source}${rev}`);
  if (p.record.blocked !== null)
    lines.push(`  priorities BLOCKED ${p.record.blocked}`);
  if (p.record.lastValid !== null)
    lines.push(
      `  priorities last valid revision ${p.record.lastValid.revision} (${p.record.lastValid.commit}), ${p.record.lastValid.ageDays} day(s) old`,
    );
  for (const problem of p.weights.problems)
    lines.push(`  priorities weights: ${problem}`);
  const { ranking } = p;
  lines.push(
    `  lanes    ${ranking.lanes
      .map(
        (l) =>
          `${l.lane} ${l.inRotation ? `${Math.round(l.share * 100)}%` : "out"} (week ${l.weekStarts}, proposed ${l.proposed})`,
      )
      .join(", ")}`,
  );
  const { floor } = ranking;
  lines.push(
    `  floor    peripheral owed ${floor.owed} (opening debt ${floor.d0}${floor.d0Reason === null ? "" : `: ${floor.d0Reason}`})${floor.lent > 0 ? `; lent ${floor.lent} start(s) with no peripheral work ready` : ""}`,
  );
  for (const s of ranking.shortlist.slice(0, SHOWN))
    lines.push(
      `  proposes ${String(s.position).padStart(2)}. ${s.key} [${s.lane}${s.objective === null ? "" : ` ${s.objective}`}]: ${s.reason}${s.gaps.length > 0 ? `; gaps: ${s.gaps.join(", ")}` : ""}`,
    );
  if (ranking.shortlist.length === 0)
    lines.push("  proposes nothing: no ranked work is ready");
  const started = [
    ...r.actions.filter((a) => a.stage === "pickup").map((a) => a.target),
    ...r.launches
      .filter((l) => l.action === "pickup" && l.outcome === "launched")
      .map((l) => l.target),
  ];
  lines.push(
    `  ${verb === "wants" ? "started " : "would   "} ${started.length === 0 ? "no pickup" : [...new Set(started)].join(", ")} (dispatch's own selection)`,
  );
  for (const d of ranking.disagreements)
    lines.push(
      `  disagree ${d.objective}: ${d.ahead.key} (epic ${d.ahead.epic ?? "-"}, priority ${d.ahead.priority}) ranks ahead of ${d.behind.key} (epic ${d.behind.epic ?? "-"}, priority ${d.behind.priority}): ${d.rule}`,
    );
  return lines;
}
