/**
 * The reflection route: each class that recurs (`recurring.ts`) recorded as
 * one finding in the reflection store per week, at the end of a tick, after
 * every launch. It records and never steers: it changes no cap, expectation,
 * nudge or other dial, and what to change stays a person's decision in
 * `/jig:review-reflections`.
 *
 * A repository's route is on when reflection is (a `reflection` section in a
 * configuration layer, the repository's layer read from its default branch as
 * the dispatch section is), for a tick with `--apply` on the host that owns
 * the repository; a tick that only reports lists what it would record. The
 * finding's id is derived from the repository, the stage, the class and the
 * host-time ISO week, so every later tick that week finds it already kept
 * (`reflection-findings.ts`) and records nothing, and a class that still
 * recurs in a new week is a new occurrence, which counts toward its
 * escalation. Its target is the dispatcher as a Jig tool, so only a review of
 * Jig's own findings escalates it, never an unattended session in the
 * repository.
 *
 * Each append runs under the store's deadline, cut to the time the tick has
 * left. One that fails leaves its findings pending, says why on the receipt,
 * and is sent again, the same bytes, by the next tick; it never changes the
 * tick's exit status.
 */
import type { Database } from "bun:sqlite";
import { layeredConfig, withSource } from "../../shared/consumer.ts";
import { Defect } from "../../shared/errors.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  repositoryId,
  sessionBlock,
} from "../../skills/reflect/scripts/lib/context.ts";
import {
  derivedId,
  eventProblems,
  type FindingEvent,
  nowAt,
  parseEvent,
  type ReflectionEvent,
} from "../../skills/reflect/scripts/lib/events.ts";
import {
  parseReflection,
  type Reflection,
  type ReflectionSettings,
} from "../../skills/reflect/scripts/lib/settings.ts";
import {
  EXIT,
  failureOf,
  Store,
  storeCommand,
} from "../../skills/reflect/scripts/lib/store-client.ts";
import { stateRoot } from "../receipts.ts";
import type { RecurringClass } from "./dashboard-contract.ts";
import { dateIn, hostTimeZone, isoWeekIn, wallClockIn } from "./host-time.ts";
import {
  addFinding,
  hasFinding,
  markStored,
  pendingFindings,
} from "./reflection-findings.ts";
import {
  commonReasons,
  RECURRENCE_DAYS,
  recurrenceDays,
  recurringClasses,
} from "./recurring.ts";
import { stateDb } from "./state.ts";
import { failureText } from "./text.ts";

/** One repository as the tick read it, for its route. */
export interface RepoReflection {
  slug: string;
  /** The checkout the tick was given, which names the repository in a finding as the reflect skill names it. */
  path: string;
  reflection: Outcome<Reflection, "reflection-unreadable">;
  /** Whether this host owns the repository: only the owner records, so a recurrence is recorded once. */
  owner: boolean;
}

/** A finding the route made of a recurring class. */
export interface RecurrenceFinding {
  id: string;
  repo: string;
  stage: string;
  class: string;
  week: string;
}

/** What the route did in one tick, for its receipt. */
export interface ReflectionReport {
  /** Findings the store reported stored in this tick. */
  recorded: RecurrenceFinding[];
  /** Findings still waiting for the store, which the next applying tick sends again. */
  pending: RecurrenceFinding[];
  /** In a tick that only reports: the findings an applying tick would record. */
  would: RecurrenceFinding[];
  /** Why a repository's findings were not made or not stored. */
  failures: Array<{ repo: string; code: RouteFailure; reason: string }>;
}

export type RouteFailure =
  | "reflection-unreadable"
  | "repository-unread"
  | "store-unavailable"
  | "store-failed"
  | "no-time"
  | "defect";

export interface RouteOptions {
  /** Whether the tick applies; one that only reports appends nothing. */
  apply: boolean;
  nowMs: number;
  timeZone?: string;
  root?: string;
  /** What the tick has left of its deadline, which an append's deadline is cut to; `null` for no limit. */
  timeLeftMs?: number | null;
}

/**
 * The repository's reflection settings: its default branch's configuration
 * file (`file`, read from `where`) as the repository layer, beside the user
 * file and the environment.
 */
export function repositoryReflection(
  path: string,
  file: string | null,
  where: string,
  env: Record<string, string | undefined> = process.env,
): Outcome<Reflection, "reflection-unreadable"> {
  return attempt(
    "reflection-unreadable",
    `the reflection settings do not read (the repository's layer is ${where})`,
    () => {
      const values = layeredConfig(path, env, file).values;
      try {
        return parseReflection(values.reflection, path);
      } catch (error) {
        throw withSource(values, "reflection", error);
      }
    },
  );
}

/** An outcome class as a reflection class name: `gates failed` is `dispatch-recurring-gates-failed`. */
export function findingClass(outcome: string): string {
  return `dispatch-recurring-${outcome
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A query string value as the dashboard writes it in its address. */
function queryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":");
}

/** The dashboard's filter that shows a recurring class's rows over its seven days. */
export function dashboardFilter(
  r: Pick<RecurringClass, "class" | "repo" | "stage">,
  nowMs: number,
  timeZone: string,
): string {
  const [from] = recurrenceDays(nowMs, timeZone);
  return [
    ["view", "history"],
    ["from", wallClockIn(timeZone, from ?? nowMs)],
    // The minute after now, so a row written this minute is inside it.
    ["to", wallClockIn(timeZone, nowMs + 60_000)],
    ["repo", r.repo],
    ["stage", r.stage],
    ["class", r.class],
  ]
    .map(([k, v]) => `${k}=${queryValue(v ?? "")}`)
    .join("&");
}

/** What a finding about one recurring class says. */
function findingText(
  db: Database,
  r: RecurringClass,
  nowMs: number,
  timeZone: string,
  week: string,
): Pick<FindingEvent, "title" | "description" | "suggested_fix"> {
  const starts = recurrenceDays(nowMs, timeZone);
  const days = starts
    .filter((_, i) => r.nights[i])
    .map((start) => dateIn(timeZone, start));
  const reasons = commonReasons(db, r, nowMs, timeZone)
    .map((c) => `"${c.reason}" (${plural(c.rows, "row")})`)
    .join("; ");
  return {
    title: `${r.class} recurred on the ${r.stage} stage of ${r.repo} on ${days.length} of the last ${RECURRENCE_DAYS} days`,
    description: [
      `The dispatcher's outcome log shows the class ${r.class} on the ${r.stage} stage of ${r.repo} on ${days.length} of the seven host days to ${dateIn(timeZone, nowMs)} (${days.join(", ")}), ${plural(r.rows, "row")} in all.`,
      `The reasons given most often: ${reasons}.`,
      `The dashboard's History view shows these rows with the filter ${dashboardFilter(r, nowMs, timeZone)}, added to the address jig dispatch dashboard prints.`,
      `The dispatcher records a class that recurs once per week (this is ${week}); a class still recurring in a later week is a new finding.`,
    ].join(" "),
    suggested_fix: `Read the rows the filter shows, then decide what makes the ${r.stage} stage end this way on this repository: a dispatcher limit or expectation, a skill's step, or the repository's own instructions, gates or configuration. When the cause is the repository's, move the finding to its scaffolding. The dispatcher changes nothing itself.`,
  };
}

/** The finding event for one recurring class, its id derived from the repository, stage, class and week. */
function findingEvent(
  db: Database,
  r: RecurringClass,
  repository: string,
  nowMs: number,
  timeZone: string,
): FindingEvent {
  const week = isoWeekIn(timeZone, nowMs);
  const event: FindingEvent = {
    v: 1,
    type: "finding",
    id: findingId(repository, r, week),
    at: nowAt(new Date(nowMs)),
    session: sessionBlock(import.meta.dir),
    change: { repository, branch: null, pull_request: null, issue: null },
    kind: "error",
    severity: "medium",
    class: findingClass(r.class),
    target: { scope: "tool", tool: "jig", name: "dispatch" },
    ...findingText(db, r, nowMs, timeZone, week),
  };
  const problems = eventProblems(event);
  if (problems.length > 0)
    throw new Defect(`the finding does not read: ${problems.join("; ")}`);
  return event;
}

function findingId(
  repository: string,
  r: Pick<RecurringClass, "class" | "stage">,
  week: string,
): string {
  return derivedId([repository, "dispatch-recurring", r.stage, r.class, week]);
}

interface RepoRun {
  db: Database;
  repo: RepoReflection;
  settings: ReflectionSettings;
  options: RouteOptions;
  timeZone: string;
  report: ReflectionReport;
}

const failure = (
  run: RepoRun,
  code: RouteFailure,
  reason: string,
): ReflectionReport["failures"][number] => ({
  repo: run.repo.slug,
  code,
  reason,
});

/**
 * Keep a pending finding for each recurring class of the repository not
 * found before this week; in a tick that only reports, list them instead.
 */
function findRecurrences(run: RepoRun): void {
  const { db, repo, options, timeZone, report } = run;
  const recurring = recurringClasses(db, options.nowMs, timeZone, repo.slug);
  if (recurring.length === 0) return;
  const id = attempt(
    "repository-unread",
    "the repository's name for the reflection store could not be read",
    () => repositoryId(repo.path),
  );
  if (!id.ok) {
    report.failures.push(failure(run, id.failure.code, id.failure.reason));
    return;
  }
  const week = isoWeekIn(timeZone, options.nowMs);
  for (const r of recurring) {
    const found = {
      id: findingId(id.value, r, week),
      repo: repo.slug,
      stage: r.stage,
      class: r.class,
      week,
    };
    if (hasFinding(db, found.id)) continue;
    if (!options.apply) {
      report.would.push(found);
      continue;
    }
    const event = findingEvent(db, r, id.value, options.nowMs, timeZone);
    addFinding(db, { ...found, event: JSON.stringify(event), at: event.at });
  }
}

/**
 * Send the repository's pending findings to its store, under the store's
 * deadline cut to the tick's time left; a tick that only reports lists them.
 */
async function appendPending(run: RepoRun): Promise<void> {
  const { db, repo, settings, options, report } = run;
  const pending = pendingFindings(db, repo.slug);
  if (pending.length === 0) return;
  const listed = pending.map((p) => ({
    id: p.id,
    repo: p.repo,
    stage: p.stage,
    class: p.class,
    week: p.week,
  }));
  if (!options.apply) {
    report.pending.push(...listed);
    return;
  }
  const leftSec =
    options.timeLeftMs == null
      ? settings.timeoutSec
      : Math.floor(options.timeLeftMs / 1000);
  if (leftSec < 1) {
    report.pending.push(...listed);
    report.failures.push(
      failure(
        run,
        "no-time",
        "this tick has no time left for the store; the next tick sends its findings",
      ),
    );
    return;
  }
  const store = new Store(
    storeCommand(settings),
    Math.min(settings.timeoutSec, leftSec),
  );
  const appended = await appendEvents(
    store,
    pending.map((p) => parseEvent(p.event)),
  );
  if (!appended.ok) {
    report.pending.push(...listed);
    report.failures.push(
      failure(
        run,
        appended.failure.code,
        `${appended.failure.reason}; the next tick sends its findings again`,
      ),
    );
    return;
  }
  const at = nowAt();
  for (const stored of appended.value)
    markStored(db, stored.id, at, stored.ref);
  report.recorded.push(...listed);
}

/** The store's append as a value: what it stored, or why it did not. */
async function appendEvents(
  store: Store,
  events: ReflectionEvent[],
): Promise<
  Outcome<
    Array<{ id: string; ref: string | null }>,
    "store-unavailable" | "store-failed"
  >
> {
  try {
    return ok(await store.append(events));
  } catch (error) {
    const { code, message } = failureOf(error);
    return failed(
      code === EXIT.unavailable ? "store-unavailable" : "store-failed",
      message,
      error,
    );
  }
}

/** One repository's route; a defect in it is reported and stops only this repository's. */
async function routeRepo(
  db: Database,
  repo: RepoReflection,
  options: RouteOptions,
  report: ReflectionReport,
): Promise<void> {
  if (!repo.owner) return;
  if (!repo.reflection.ok) {
    report.failures.push({
      repo: repo.slug,
      code: repo.reflection.failure.code,
      reason: repo.reflection.failure.reason,
    });
    return;
  }
  const settings = repo.reflection.value;
  if (!settings.on) return;
  const run: RepoRun = {
    db,
    repo,
    settings,
    options,
    timeZone: options.timeZone ?? hostTimeZone(),
    report,
  };
  try {
    findRecurrences(run);
    await appendPending(run);
  } catch (error) {
    console.error(error);
    report.failures.push(failure(run, "defect", failureText(error)));
  }
}

/**
 * The route for every repository the tick read: what it recorded, left
 * pending, would record or could not do; `null` when it had nothing to do,
 * as on a host with reflection off.
 */
export async function routeRecurrences(
  repos: readonly RepoReflection[],
  options: RouteOptions,
): Promise<ReflectionReport | null> {
  const report: ReflectionReport = {
    recorded: [],
    pending: [],
    would: [],
    failures: [],
  };
  if (
    !repos.some((r) => r.owner && (!r.reflection.ok || r.reflection.value.on))
  )
    return null;
  const db = stateDb(options.root ?? stateRoot());
  for (const repo of repos) await routeRepo(db, repo, options, report);
  const empty = Object.values(report).every((list) => list.length === 0);
  return empty ? null : report;
}
