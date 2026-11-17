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
  const lines: string[] = recordLines(p.record);
  for (const problem of p.weights.problems)
    lines.push(`  priorities weights: ${problem}`);
  const { ranking } = p;
  lines.push(...laneLines(ranking));
  for (const s of ranking.shortlist.slice(0, SHOWN))
    lines.push(
      `  proposes ${String(s.position).padStart(2)}. ${s.key} [${s.lane}${s.objective === null ? "" : ` ${s.objective}`}]: ${s.reason}${s.gaps.length > 0 ? `; gaps: ${s.gaps.join(", ")}` : ""}`,
    );
  if (ranking.shortlist.length === 0)
    lines.push("  proposes nothing: no ranked work is ready");
  const started = startedTargets(r, verb === "wants");
  lines.push(
    `  ${verb === "wants" ? "started " : "would   "} ${started.length === 0 ? "no pickup" : [...new Set(started)].join(", ")} (dispatch's own selection)`,
  );
  for (const d of ranking.disagreements)
    lines.push(
      `  disagree ${d.objective}: ${d.ahead.key} (epic ${d.ahead.epic ?? "-"}, priority ${d.ahead.priority}) ranks ahead of ${d.behind.key} (epic ${d.behind.epic ?? "-"}, priority ${d.behind.priority}): ${d.rule}`,
    );
  return lines;
}

type Ranking =
  NonNullable<RepoReport["priorities"]> extends infer T
    ? T extends { ranking: infer R }
      ? R
      : never
    : never;

function laneLines(ranking: Ranking): string[] {
  const { floor } = ranking;
  const lanes = ranking.lanes
    .map(
      (l) =>
        `${l.lane} ${l.inRotation ? `${Math.round(l.share * 100)}%` : "out"} (week ${l.weekStarts}, proposed ${l.proposed})`,
    )
    .join(", ");
  const opening = floor.d0Reason === null ? "" : `: ${floor.d0Reason}`;
  const lent =
    floor.lent > 0
      ? `; lent ${floor.lent} start(s) with no peripheral work ready`
      : "";
  return [
    `  lanes    ${lanes}`,
    `  floor    peripheral owed ${floor.owed} (opening debt ${floor.d0}${opening})${lent}`,
  ];
}

function recordLines(
  record: NonNullable<RepoReport["priorities"]> extends infer T
    ? T extends { record: infer R }
      ? R
      : never
    : never,
): string[] {
  const rev = record.revision === null ? "" : `, revision ${record.revision}`;
  const lines = [`  priorities record ${record.source}${rev}`];
  if (record.blocked !== null)
    lines.push(`  priorities BLOCKED ${record.blocked}`);
  if (record.lastValid !== null)
    lines.push(
      `  priorities last valid revision ${record.lastValid.revision} (${record.lastValid.commit}), ${record.lastValid.ageDays} day(s) old`,
    );
  return lines;
}

/** An applied receipt names what launched; a dry run names what the plan would pick up. */
function startedTargets(r: RepoReport, applied: boolean): string[] {
  return applied
    ? r.launches
        .filter((l) => l.action === "pickup" && l.outcome === "launched")
        .map((l) => l.target)
    : r.actions.filter((a) => a.stage === "pickup").map((a) => a.target);
}
