/**
 * The tick's refresh of each repository's conflict rates, at most once a day
 * (`REFRESH_EVERY_MS`), after its act phase and with every lock of that phase
 * given up, so a slow replay never delays a launch or another tick.
 *
 * The refresh runs `resolve-conflicts`' `history.ts --rates` in the
 * repository's checkout as a child process with a deadline: the shorter of
 * `REFRESH_DEADLINE_MS` and what is left of the tick's own. The child reads
 * the merged pull requests through the forge's governed transport, charged
 * to the tick (`JIG_OUTBOUND_CALLER`), and writes the rates to a file beside
 * the one in use; that file replaces the one in use only when the child
 * exits 0 within its deadline and what it wrote reads as rates. Anything
 * else (an error, a cohort that did not read in full, a deadline passed)
 * keeps the previous file, and the refresh record says why.
 *
 * The refresh record (`ratesPaths(...).refresh`) is written before the
 * child starts, so a run the host stops still counts as the day's attempt.
 */
import {
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { swallow } from "../../shared/errors.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
import {
  run as runProcess,
  tsArgv,
} from "../../skills/drive-pr/scripts/lib/proc.ts";
import { parseRates } from "../../skills/resolve-conflicts/scripts/lib/rates.ts";
import { takeRatesLock, stateRoot } from "../receipts.ts";
import {
  ratesPaths,
  readRefreshRecord,
  type RefreshRecord,
} from "./conflict-rates.ts";
import { defectOf, logDefect } from "./defect.ts";

/** How often a repository's rates are refreshed at most. */
export const REFRESH_EVERY_MS = 86_400_000;

/** The longest one refresh runs. */
export const REFRESH_DEADLINE_MS = 10 * 60_000;

/** The least time a refresh is started with: with less of the tick left, it waits for a later tick. */
const MIN_REFRESH_MS = 60_000;

/** The window the rates count, in days. */
const RATES_WINDOW_DAYS = 30;

const HISTORY = resolve(
  import.meta.dir,
  "../../skills/resolve-conflicts/scripts/history.ts",
);

/** A repository whose rates the tick refreshes: its forge name and its checkout. */
export interface RatesTarget {
  slug: string;
  path: string;
}

/** A repository the tick acted on, as the refresh chooses among them. */
export interface ActedRepository extends RatesTarget {
  /** Whether the machine file lists it, and the stages it enables there. */
  listed: boolean;
  stages: readonly string[];
}

/**
 * The repositories whose rates an applying tick refreshes: those the machine
 * file lists with pickups enabled, the work overlap-aware admission orders.
 * A tick that does not apply refreshes none.
 */
export function eligibleTargets(
  repos: readonly ActedRepository[],
  apply: boolean,
): RatesTarget[] {
  if (!apply) return [];
  const seen = new Set<string>();
  return repos.flatMap(({ slug, path, listed, stages }) => {
    if (!listed || !stages.includes("pickup") || seen.has(slug)) return [];
    seen.add(slug);
    return [{ slug, path }];
  });
}

/** How the child ran. */
export type RunHistory = (
  argv: string[],
  opts: {
    cwd: string;
    timeoutSec: number;
    env: Record<string, string | undefined>;
  },
) => Promise<{ code: number; stderr: string; timedOut: boolean }>;

const runHistory: RunHistory = async (argv, opts) => {
  const r = await runProcess(argv, {
    ...opts,
    stdout: "ignore",
    stderr: "pipe",
  });
  return { code: r.code, stderr: r.stderr, timedOut: r.timedOut };
};

export type RefreshOutcome =
  | { slug: string; outcome: "written" }
  | { slug: string; outcome: "kept"; reason: string }
  | { slug: string; outcome: "skipped"; reason: string };

export interface RefreshOptions {
  nowMs: number;
  /** The tick's deadline, epoch milliseconds; none for a tick no launcher bounds. */
  deadlineMs: number | undefined;
  root?: string;
  run?: RunHistory;
  /** Whom the child's forge calls are charged to. */
  caller?: string;
}

function writeRecord(path: string, record: RefreshRecord): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Why a refresh need not run now, or null when it is due. */
function notDue(last: RefreshRecord | null, nowMs: number): string | null {
  if (last === null) return null;
  const next = parseMs(last.attemptedAt) + REFRESH_EVERY_MS;
  return nowMs < next
    ? `refreshed at most once a day: the last attempt was at ${last.attemptedAt}, the next is due at ${isoFromMs(next)}`
    : null;
}

/** The child's last line of error output, which says why it stopped. */
function lastLine(stderr: string): string {
  return stderr.trim().split("\n").at(-1)?.trim() ?? "";
}

/** Whether what the child wrote reads as rates of `slug`. */
function readsAsRates(path: string, slug: string): boolean {
  try {
    const rates = parseRates(JSON.parse(readFileSync(path, "utf8")));
    return rates !== null && rates.repository === slug;
  } catch (err) {
    swallow(
      err,
      "a file the child wrote that does not read is not put in place",
    );
    return false;
  }
}

/** Run one repository's refresh, under its lock, and say how it ended. */
async function refreshLocked(
  target: RatesTarget,
  options: RefreshOptions,
  root: string,
): Promise<RefreshOutcome> {
  const { slug } = target;
  const paths = ratesPaths(slug, root);
  const skipped = notDue(readRefreshRecord(paths.refresh), options.nowMs);
  if (skipped !== null) return { slug, outcome: "skipped", reason: skipped };
  const left =
    options.deadlineMs === undefined
      ? REFRESH_DEADLINE_MS
      : Math.min(REFRESH_DEADLINE_MS, options.deadlineMs - options.nowMs);
  if (left < MIN_REFRESH_MS)
    return {
      slug,
      outcome: "skipped",
      reason:
        "the tick has too little time left before its deadline; a later tick refreshes them",
    };
  const attemptedAt = isoFromMs(options.nowMs);
  writeRecord(paths.refresh, { version: 1, attemptedAt, outcome: "started" });
  const staging = `${paths.rates}.next`;
  rmSync(staging, { force: true });
  const timeoutSec = Math.floor(left / 1000);
  const result = await (options.run ?? runHistory)(
    tsArgv(HISTORY, [
      "--days",
      String(RATES_WINDOW_DAYS),
      "--rates",
      "--out",
      staging,
      "--cohort-cache",
      paths.cohort,
    ]),
    {
      cwd: target.path,
      timeoutSec,
      env: {
        ...process.env,
        ...(options.caller === undefined
          ? {}
          : { JIG_OUTBOUND_CALLER: options.caller }),
      },
    },
  );
  let outcome: RefreshOutcome;
  if (result.timedOut)
    outcome = {
      slug,
      outcome: "kept",
      reason: `the refresh ran past its deadline of ${timeoutSec} seconds`,
    };
  else if (result.code !== 0)
    outcome = {
      slug,
      outcome: "kept",
      reason: `history.ts --rates exited ${result.code}${lastLine(result.stderr) === "" ? "" : `: ${lastLine(result.stderr)}`}`,
    };
  else if (!readsAsRates(staging, slug))
    outcome = {
      slug,
      outcome: "kept",
      reason:
        "history.ts --rates wrote a file that does not read as the repository's rates",
    };
  else {
    renameSync(staging, paths.rates);
    outcome = { slug, outcome: "written" };
  }
  rmSync(staging, { force: true });
  writeRecord(paths.refresh, {
    version: 1,
    attemptedAt,
    outcome: outcome.outcome === "written" ? "written" : "kept",
    ...(outcome.outcome === "kept" ? { reason: outcome.reason } : {}),
  });
  return outcome;
}

/** Refresh one repository's conflict rates when they are due; how it went. */
export async function refreshConflictRates(
  target: RatesTarget,
  options: RefreshOptions,
): Promise<RefreshOutcome> {
  const root = options.root ?? stateRoot();
  const lock = takeRatesLock(target.slug, root);
  if ("heldBy" in lock)
    return {
      slug: target.slug,
      outcome: "skipped",
      reason: `another tick is refreshing them: ${lock.heldBy}`,
    };
  try {
    return await refreshLocked(target, options, root);
  } finally {
    lock.release();
  }
}

/** What the tick hands the refresh once its act phase is done. */
export interface AfterAct {
  /** Whether the tick applied: a tick that only reports refreshes nothing. */
  apply: boolean;
  deadlineMs: number | undefined;
  /** Whom the refreshes' forge calls are charged to. */
  caller: string;
}

/**
 * Refresh, one after another, the rates of each repository the tick acted
 * on that `eligibleTargets` chooses. A refresh that keeps the previous file
 * says why on the error output, which the tick's journal keeps; a defect in
 * one stops that repository's refresh only.
 */
export async function refreshEligible(
  repos: readonly ActedRepository[],
  tick: AfterAct,
): Promise<RefreshOutcome[]> {
  const outcomes: RefreshOutcome[] = [];
  for (const target of eligibleTargets(repos, tick.apply)) {
    try {
      const outcome = await refreshConflictRates(target, {
        nowMs: currentMs(),
        deadlineMs: tick.deadlineMs,
        caller: tick.caller,
      });
      if (outcome.outcome === "kept")
        console.error(
          `jig dispatch: ${target.slug}'s conflict rates were not refreshed, and the previous ones are kept: ${outcome.reason}`,
        );
      outcomes.push(outcome);
    } catch (error) {
      logDefect(
        `${target.slug}'s conflict rates refresh`,
        defectOf("rates", error),
        error,
      );
    }
  }
  return outcomes;
}
