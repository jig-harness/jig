/**
 * The tick strip as pure functions of the line: one row per recent tick, the
 * newest first, with its duration, its own phases as a bar, the slowest single
 * phase, the forge budget it read and what went wrong. What a receipt did not
 * record is left out: a tick that timed no phase has no bar, one that read no
 * budget says nothing of it.
 */
import type {
  LineSnapshot,
  LineTick,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { hostDay, plural, seconds, stamp } from "./format.ts";
import type { Clock } from "./view.ts";

/** The tick's own phases, in the order they run; the bar shows them in this order. */
export const TICK_PHASES = [
  "start",
  "repos",
  "observe",
  "wait",
  "act",
  "close",
] as const;

/** What each of the tick's own phases is, for the bar's legend. */
export const TICK_PHASE_MEANINGS: Record<string, string> = {
  start: "reading this host's launch records and the shared reads",
  repos: "every repository's turn, one after another",
  observe: "reading every repository, several at once",
  wait: "waiting for the act lock another tick held",
  act: "planning and launching, one repository after another",
  close: "settling the outcome log and writing this line",
};

/** The tick-level phases that add up the repositories' own, which the slowest phase names per repository instead. */
const AGGREGATE = new Set(["repos", "observe", "act"]);

/** One segment of a tick's bar: its phase and its part of the tick. */
export interface PhaseSpan {
  phase: string;
  ms: number;
  /** Its share of the bar, from 0 to 1. */
  share: number;
}

/** Something that went wrong in a tick, as a word, and what it means. */
export interface TickMark {
  word: string;
  tone: "badly" | "waiting" | "held";
  meaning: string;
}

export interface TickRepoView {
  repo: string;
  took: string;
  /** Its phases, the slowest first: `forge 30 s · claims 12 s`, each held together by no-break spaces. */
  phases: string;
  defect: string | null;
}

export interface TickRowView {
  key: string;
  /** When it started: a clock for today, a date and clock before. */
  at: string;
  took: string;
  /** Its length beside the longest of the ticks shown, from 0 to 1, which the bar's width is. */
  scale: number;
  phases: PhaseSpan[];
  /** The slowest single phase, in words: `forge in acme/web, 30 s`; `null` when it timed none. */
  slowest: string | null;
  /** How many repositories it read, and whether that was the whole machine file. */
  scope: string;
  /** The forge budget it read, as numbers written out (`4,200`); `null` when it read none. */
  budget: { remaining: string; limit: string } | null;
  marks: TickMark[];
  repos: TickRepoView[];
  /** The busy repositories' paths. */
  busy: string[];
  /** The reads the low budget skipped. */
  skipped: string[];
}

/** The slowest single phase: one repository's, or the tick's own outside the repositories' turns. */
export function slowestPhase(
  tick: Pick<LineTick, "phasesMs" | "repos">,
): { phase: string; repo: string | null; ms: number } | null {
  let slowest: { phase: string; repo: string | null; ms: number } | null = null;
  const consider = (phase: string, repo: string | null, ms: number) => {
    if (slowest === null || ms > slowest.ms) slowest = { phase, repo, ms };
  };
  for (const [phase, ms] of Object.entries(tick.phasesMs))
    if (!AGGREGATE.has(phase)) consider(phase, null, ms);
  for (const repo of tick.repos)
    for (const [phase, ms] of Object.entries(repo.phasesMs))
      consider(phase, repo.repo, ms);
  return slowest;
}

function phaseSpans(tick: LineTick): PhaseSpan[] {
  const known = TICK_PHASES.filter((p) => tick.phasesMs[p] !== undefined);
  const others = Object.keys(tick.phasesMs).filter(
    (p) => !(TICK_PHASES as readonly string[]).includes(p),
  );
  const order = [...known, ...others];
  const total = Math.max(
    tick.tookMs,
    order.reduce((sum, p) => sum + (tick.phasesMs[p] ?? 0), 0),
    1,
  );
  return order.map((phase) => {
    const ms = tick.phasesMs[phase] ?? 0;
    return { phase, ms, share: ms / total };
  });
}

function marksOf(tick: LineTick): TickMark[] {
  const marks: TickMark[] = [];
  if (tick.defects > 0)
    marks.push({
      word: plural(tick.defects, "defect"),
      tone: "badly",
      meaning:
        "Something no code expected was thrown, and stopped the tick's closing steps or a repository's turn; the receipt has the reason and the tick's error output the stack.",
    });
  if (tick.lowBudget !== null)
    marks.push({
      word: "low budget",
      tone: "waiting",
      meaning: `The forge's rate budget was low as the tick started, so it skipped its optional reads${tick.lowBudget.length > 0 ? `: ${tick.lowBudget.join(", ")}` : ""}.`,
    });
  if (tick.busy.length > 0)
    marks.push({
      word: `${tick.busy.length} busy`,
      tone: "held",
      meaning: `Another tick held ${plural(tick.busy.length, "repository", "repositories")}, so this one neither read nor acted on ${tick.busy.length === 1 ? "it" : "them"}.`,
    });
  if (tick.exitStatus !== 0 && tick.defects === 0)
    marks.push({
      word: `exit ${tick.exitStatus}`,
      tone: "badly",
      meaning:
        "The tick ended with a failure it reported: a read, a record or a write it could not make. Its receipt says which.",
    });
  return marks;
}

function repoView(repo: LineTick["repos"][number]): TickRepoView {
  return {
    repo: repo.repo,
    took: seconds(repo.ms),
    phases: Object.entries(repo.phasesMs)
      .sort((a, b) => b[1] - a[1])
      // Each phase and its time stay on one line where the list wraps.
      .map(([phase, ms]) => `${phase} ${seconds(ms)}`.replace(/ /g, "\u00a0"))
      .join(" · "),
    defect: repo.defect,
  };
}

function budgetOf(budget: LineTick["budget"]): TickRowView["budget"] {
  if (budget === null) return null;
  const n = (v: number) => v.toLocaleString("en-US");
  return { remaining: n(budget.remaining), limit: n(budget.limit) };
}

/** The rows of the strip, the newest tick first. */
export function tickRows(
  line: LineSnapshot | null,
  clock: Clock,
): TickRowView[] {
  const ticks = [...(line?.ticks ?? [])].reverse();
  const longest = Math.max(1, ...ticks.map((t) => t.tookMs));
  const today = hostDay(clock.nowMs, clock.timeZone);
  const listed = line?.repos.length ?? 0;
  return ticks.map((tick) => {
    const slowest = slowestPhase(tick);
    const repos = plural(tick.repos.length, "repository", "repositories");
    return {
      key: tick.runId,
      at: stamp(Date.parse(tick.startedAt), today, clock.timeZone),
      took: seconds(tick.tookMs),
      scale: tick.tookMs / longest,
      phases: phaseSpans(tick),
      slowest:
        slowest === null
          ? null
          : `${slowest.phase}${slowest.repo === null ? "" : ` in ${slowest.repo}`}, ${seconds(slowest.ms)}`,
      scope: tick.sweep
        ? `${repos}, all`
        : `${tick.repos.length} of ${plural(listed, "repository", "repositories")}`,
      budget: budgetOf(tick.budget),
      marks: marksOf(tick),
      repos: tick.repos.map(repoView),
      busy: tick.busy,
      skipped: tick.lowBudget ?? [],
    };
  });
}
