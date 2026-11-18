/**
 * The priorities part of a repository's report as a person reads it: the
 * record the ranking used, the weights file's problems, each weighted lane's
 * share beside its starts this week, the floor owed, the shortlist, and what
 * dispatch actually started this tick beside it. Under the host's
 * `priorities.enforce` the ranking set the pickups' order: each start then
 * names the lane and objective it is charged to and why, a pickup that did
 * not start names why it passed its start on, and a pickup held back names
 * its paused lane.
 */
import type { EnforcedOrder, OrderedStart } from "./priorities-order.ts";
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
  lines.push(...laneLines(ranking), ...shortlistLines(ranking));
  if (p.enforced === undefined) lines.push(dispatchSelectionLine(r, verb));
  else lines.push(...enforcedLines(r, p.enforced, verb === "wants"));
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

function shortlistLines(ranking: Ranking): string[] {
  if (ranking.shortlist.length === 0)
    return ["  proposes nothing: no ranked work is ready"];
  return ranking.shortlist.slice(0, SHOWN).map((s) => {
    const charged = s.objective === null ? "" : ` ${s.objective}`;
    const gaps = s.gaps.length > 0 ? `; gaps: ${s.gaps.join(", ")}` : "";
    return `  proposes ${String(s.position).padStart(2)}. ${s.key} [${s.lane}${charged}]: ${s.reason}${gaps}`;
  });
}

/** The line for a tick that ordered nothing: dispatch's own selection. */
function dispatchSelectionLine(r: RepoReport, verb: string): string {
  const started = startedTargets(r, verb === "wants");
  const names =
    started.length === 0 ? "no pickup" : [...new Set(started)].join(", ");
  return `  ${verb === "wants" ? "started " : "would   "} ${names} (dispatch's own selection)`;
}

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

/** The enforced order: each start's charge and why, what did not start and why, and what a paused lane held back. */
function enforcedLines(
  r: RepoReport,
  order: EnforcedOrder,
  applied: boolean,
): string[] {
  const lines: string[] = [];
  if (order.starts.length === 0)
    lines.push("  starts   no pickup (in the ranking's order)");
  for (const s of order.starts) {
    const charged = `[${s.lane}${s.objective === null ? "" : ` ${s.objective}`}]`;
    const [verb, why] = applied ? appliedStart(r, s) : ["would   ", s.why];
    lines.push(`  ${verb} ${s.target} ${charged}: ${why}`);
  }
  for (const w of order.withheld)
    lines.push(`  withheld ${w.target} [${w.lane}]: ${w.why}`);
  return lines;
}

/** How an applied tick's launch of one ordered pickup went: started with the ranking's reason, or what kept it from starting. */
function appliedStart(r: RepoReport, s: OrderedStart): [string, string] {
  const launch = r.launches.find(
    (l) => l.action === "pickup" && l.target === s.target,
  );
  if (launch === undefined)
    return ["untried ", `no launch was tried this tick; ${s.why}`];
  if (launch.outcome === "launched") return ["started ", s.why];
  if (launch.outcome === "lost" || launch.outcome === "retried")
    return [
      "holds   ",
      `${launch.outcome}, its record holds a slot: ${launch.detail}`,
    ];
  return [
    `${launch.outcome.padEnd(8)}`,
    `did not start, and the next in the order may take the start: ${launch.detail}`,
  ];
}

/** An applied receipt names what launched; a dry run names what the plan would pick up. */
function startedTargets(r: RepoReport, applied: boolean): string[] {
  return applied
    ? r.launches
        .filter((l) => l.action === "pickup" && l.outcome === "launched")
        .map((l) => l.target)
    : r.actions.filter((a) => a.stage === "pickup").map((a) => a.target);
}
