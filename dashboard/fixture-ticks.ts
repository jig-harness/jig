/**
 * The fixtures' recent ticks, as the line carries them for the tick strip: a
 * sweep every five minutes over the five repositories, a wake-up for one
 * repository between them, and, among them, a tick that skipped its optional
 * reads for a low budget, one that found a repository busy under another tick,
 * and one with a defect.
 */
import type {
  LineTick,
  LineTickRepo,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import { API, DOC, INF, iso, MOB, pad, WEB } from "./fixture-rows.ts";

/** How many sweeps the strip holds. */
const SWEEPS = 12;
const INTERVAL_MIN = 5;
const LIMIT = 5_000;

/** The phases of each repository's turn in an ordinary sweep, by repository. */
const TURNS: Record<string, Record<string, number>> = {
  [WEB]: {
    open: 620,
    tracker: 1_900,
    forge: 22_400,
    claims: 6_100,
    runtime: 380,
    observe: 1_200,
    plan: 40,
    log: 30,
    apply: 4_800,
    labels: 900,
    shared: 20,
  },
  [API]: {
    open: 540,
    tracker: 1_600,
    forge: 11_800,
    claims: 2_900,
    runtime: 360,
    observe: 600,
    plan: 30,
    log: 20,
    apply: 2_100,
  },
  [MOB]: { open: 480, tracker: 350, forge: 3_100, runtime: 340, plan: 10 },
  [DOC]: { open: 450, forge: 2_400, runtime: 330, plan: 10 },
  [INF]: {
    open: 510,
    tracker: 1_200,
    forge: 5_600,
    claims: 1_100,
    runtime: 350,
    plan: 20,
    apply: 900,
  },
};

const PATHS: Record<string, string> = {
  [WEB]: "/srv/work/web",
  [API]: "/srv/work/api",
  [MOB]: "/srv/work/mobile",
  [DOC]: "/srv/work/docs",
  [INF]: "/srv/work/infra",
};

function runIdAt(minute: number): string {
  return `20261103T${pad(Math.floor(minute / 60))}${pad(minute % 60)}00Z`;
}

function repoOf(
  repo: string,
  scale: number,
  defect: string | null = null,
): LineTickRepo {
  const phasesMs: Record<string, number> = {};
  for (const [phase, ms] of Object.entries(TURNS[repo] ?? {}))
    phasesMs[phase] = Math.round(ms * scale);
  const ms = Object.values(phasesMs).reduce((sum, v) => sum + v, 0);
  return { repo, ms, phasesMs, defect };
}

/** A tick that observed its repositories at once, then acted on them in turn. */
function tickOf(o: {
  minute: number;
  repos: LineTickRepo[];
  sweep: boolean;
  remaining: number;
  waitMs?: number;
  busy?: string[];
  lowBudget?: string[];
  defects?: number;
  tookMs?: number;
}): LineTick {
  const observed = Math.max(
    0,
    ...o.repos.map((r) =>
      Object.entries(r.phasesMs)
        .filter(
          ([p]) => !["plan", "log", "apply", "labels", "shared"].includes(p),
        )
        .reduce((sum, [, ms]) => sum + ms, 0),
    ),
  );
  const act = o.repos.reduce(
    (sum, r) =>
      sum +
      (r.phasesMs.apply ?? 0) +
      (r.phasesMs.labels ?? 0) +
      (r.phasesMs.plan ?? 0),
    0,
  );
  const start = 1_100;
  const wait = o.waitMs ?? 0;
  const close = 1_900;
  // A tick whose length is given spent the rest of it observing: the slowest read.
  const tookMs = o.tookMs ?? start + observed + wait + act + close;
  const observe = Math.max(observed, tookMs - start - wait - act - close);
  return {
    runId: runIdAt(o.minute),
    startedAt: iso(o.minute),
    tookMs,
    exitStatus: (o.defects ?? 0) > 0 ? 1 : 0,
    sweep: o.sweep,
    phasesMs: { start, observe, wait, act, close },
    repos: o.repos,
    budget: { remaining: o.remaining, limit: LIMIT },
    busy: o.busy ?? [],
    lowBudget: o.lowBudget ?? null,
    defects: o.defects ?? 0,
  };
}

/**
 * The strip of a line whose newest tick started at `newest` (minutes since the
 * fixture day's midnight) and took `tookMs`, the oldest first.
 */
export function recentTicks(newest: number, tookMs: number): LineTick[] {
  const all = [WEB, API, MOB, DOC, INF];
  const ticks: LineTick[] = [];
  for (let i = SWEEPS - 1; i >= 0; i--) {
    const minute = newest - i * INTERVAL_MIN;
    const spent = (SWEEPS - 1 - i) * 41;
    if (i === 7)
      ticks.push(
        tickOf({
          minute,
          sweep: false,
          repos: all.filter((r) => r !== WEB).map((r) => repoOf(r, 0.9)),
          busy: [PATHS[WEB] ?? WEB],
          remaining: 3_420 - spent,
        }),
      );
    else if (i === 4)
      ticks.push(
        tickOf({
          minute,
          sweep: true,
          repos: all.map((r) => repoOf(r, 0.7)),
          remaining: 380,
          defects: 1,
          busy: [PATHS[WEB] ?? WEB],
          lowBudget: ["thread samples", "serialization's reads"],
        }),
      );
    else if (i === 2)
      ticks.push(
        tickOf({
          minute,
          sweep: true,
          repos: all.map((r) =>
            repoOf(r, r === API ? 0.2 : 1, r === API ? "forge" : null),
          ),
          remaining: 4_610,
          defects: 1,
        }),
      );
    else
      ticks.push(
        tickOf({
          minute,
          sweep: true,
          repos: all.map((r) => repoOf(r, i === 9 ? 2.4 : 1 + (i % 3) * 0.08)),
          remaining: (i > 4 ? 3_600 : 4_900) - spent,
          ...(i === 0 ? { tookMs } : {}),
        }),
      );
    if (i > 0 && i % 2 === 1)
      ticks.push(
        tickOf({
          minute: minute + 2,
          sweep: false,
          repos: [repoOf(API, 0.8)],
          remaining: (i > 4 ? 3_580 : 4_880) - spent,
          waitMs: i === 5 ? 6_400 : 0,
        }),
      );
  }
  return ticks;
}
