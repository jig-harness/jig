/**
 * Scanner annotations: findings a static-analysis app reports as check-run
 * annotations on the pull request's head commit, the way SonarQube Cloud's
 * pull request decoration does ("Check warning on line R81" in the Files
 * changed tab).
 *
 * An annotation is not a review thread and not a code scanning alert: there is
 * nothing to reply to or resolve, and no alert to dismiss. It disappears when
 * the app next analyses a head that no longer has the finding, so the way to
 * answer one is a fix or, for a finding that stands, a line in the round's
 * summary. A tool that also uploads to code scanning shows up as threads, which
 * `code-scanning.ts` handles; the two do not overlap.
 *
 * Evidence that cannot be read is never read as a clean scan: a malformed
 * response is an error, a run whose annotation count is unreadable has its
 * annotations fetched anyway, and a run that completed without analysing the
 * head is reported as such.
 */
import { createHash } from "node:crypto";
import { isRecord } from "../../../../shared/guards.ts";

/** The app whose annotations are read when `review.scanner_apps` is unset. */
export const DEFAULT_SCANNER_APPS: readonly string[] = ["sonarqubecloud"];

/** Annotation levels that are findings; `notice` is information. */
const FINDING_LEVELS = new Set(["warning", "failure"]);

/** Check-run conclusions under which the app analysed the head. */
const ANALYSED = new Set(["success", "failure", "neutral"]);

/** One scanner annotation, as listed. */
export interface ScannerFinding {
  /** The app's slug (`sonarqubecloud`). */
  app: string;
  checkRunId: number;
  path: string;
  line: number;
  startLine: number | null;
  level: "warning" | "failure";
  /** The annotation's title: the rule's message for SonarQube Cloud. */
  title: string;
  /** The annotation's message where it says more than the title. */
  message: string | null;
  /** The first https link in the message: the tool's page for the finding. */
  url: string | null;
  /** A stable, marker-safe identity, for a deferral's `--fingerprint`. */
  fingerprint: string;
}

/** A scanner check run, with what is needed to read its annotations. */
export interface ScannerRun {
  id: number;
  app: string;
  completed: boolean;
  /** The run's conclusion once completed (`success`, `cancelled`, …). */
  conclusion: string | null;
  /** The annotation count the run reports; `null` when it is unreadable. */
  annotations: number | null;
}

/** A result, or the reason the evidence could not be read. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/**
 * Each element of `items` read by `read`, which returns the value, `null` to
 * leave the element out, or the reason it cannot be read; the first reason
 * fails the whole list.
 */
function collect<T>(
  items: unknown,
  what: string,
  read: (raw: unknown, i: number) => T | null | string,
): Read<T[]> {
  if (!Array.isArray(items))
    return { ok: false, error: `${what} are not a list` };
  const values: T[] = [];
  for (const [i, raw] of items.entries()) {
    const value = read(raw, i);
    if (typeof value === "string") return { ok: false, error: value };
    if (value !== null) values.push(value);
  }
  return { ok: true, value: values };
}

/** One check run, when it is one of `wanted`'s. */
function runOf(
  raw: unknown,
  i: number,
  wanted: ReadonlySet<string>,
): ScannerRun | null | string {
  if (!isRecord(raw) || !isRecord(raw.app)) return `check run ${i} has no app`;
  const app = str(raw.app.slug)?.toLowerCase();
  if (app === undefined || !wanted.has(app)) return null;
  const id = num(raw.id);
  const status = str(raw.status);
  if (id === null || status === null)
    return `the ${app} check run ${i} has no id or status`;
  const completed = status === "completed";
  const conclusion = completed ? str(raw.conclusion) : null;
  if (completed && conclusion === null)
    return `the ${app} check run ${id} completed with no conclusion`;
  const output = isRecord(raw.output) ? raw.output : {};
  const annotations = num(output.annotations_count);
  return { id, app, completed, conclusion, annotations };
}

/** The check runs of `apps` (slugs, case-insensitive) among a commit's check runs. */
export function scannerRuns(
  checkRuns: unknown,
  apps: readonly string[],
): Read<ScannerRun[]> {
  const wanted = new Set(apps.map((a) => a.trim().toLowerCase()));
  return collect(checkRuns, "the check runs", (raw, i) =>
    runOf(raw, i, wanted),
  );
}

/**
 * Why the listing cannot certify the head clean, both lists empty when it
 * can. Pending: a configured app with no run on the head yet (only when the
 * apps were configured, since the default app may simply not run in this
 * repository), or a run still in progress. Unanalysed: a run that completed
 * without analysing.
 */
export function unsettled(
  runs: readonly ScannerRun[],
  apps: readonly string[],
  configured: boolean,
): { pending: string[]; unanalysed: string[] } {
  const seen = new Set(runs.map((r) => r.app));
  const pending = configured
    ? apps
        .map((a) => a.trim().toLowerCase())
        .filter((a) => !seen.has(a))
        .map((a) => `${a}: no check run on the head yet`)
    : [];
  for (const r of runs)
    if (!r.completed)
      pending.push(`${r.app}: check run ${r.id} has not completed`);
  const unanalysed = runs
    .filter((r) => r.completed && !ANALYSED.has(r.conclusion ?? ""))
    .map((r) => `${r.app}: check run ${r.id} completed as ${r.conclusion}`);
  return { pending, unanalysed };
}

/** The first https link in an annotation's message. */
function linkOf(message: string | null): string | null {
  const m = message?.match(/https:\/\/[^\s)>"]+/);
  return m === null || m === undefined ? null : m[0];
}

/** A hash of what identifies the finding: the message too, since it carries the tool's issue key where the tool links one. */
function fingerprintOf(
  app: string,
  path: string,
  line: number,
  text: string,
): string {
  const digest = createHash("sha256")
    .update(`${path}\0${line}\0${text}`)
    .digest("hex")
    .slice(0, 16);
  return `${app}-${digest}`;
}

/** One annotation as a finding; `null` for a `notice`. */
function findingOf(
  run: ScannerRun,
  raw: unknown,
  i: number,
): ScannerFinding | null | string {
  const where = `check run ${run.id}'s annotation ${i}`;
  if (!isRecord(raw)) return `${where} is not an object`;
  const level = str(raw.annotation_level);
  if (level === null) return `${where} has no level`;
  if (!FINDING_LEVELS.has(level)) return null;
  const path = str(raw.path);
  const line = num(raw.end_line) ?? num(raw.start_line);
  const message = str(raw.message);
  const title = str(raw.title) ?? message;
  if (path === null || line === null || title === null)
    return `${where} is a ${level} with no path, line or text`;
  return {
    app: run.app,
    checkRunId: run.id,
    path,
    line,
    startLine: startOf(num(raw.start_line), line),
    level: level as ScannerFinding["level"],
    title,
    message: message?.trim() === title ? null : message,
    url: linkOf(message),
    fingerprint: fingerprintOf(run.app, path, line, `${title}\0${message}`),
  };
}

/** The first line of a range, when it differs from the last. */
const startOf = (start: number | null, line: number): number | null =>
  start === line ? null : start;

/** The findings among one run's annotations; `notice` annotations drop out. */
export function findingsOf(
  run: ScannerRun,
  annotations: unknown,
): Read<ScannerFinding[]> {
  return collect(annotations, `check run ${run.id}'s annotations`, (raw, i) =>
    findingOf(run, raw, i),
  );
}

/** The exit a listing ends with: 3 while unsettled, 4 when a run did not analyse, else 0. */
export function exitFor(reasons: {
  pending: readonly string[];
  unanalysed: readonly string[];
}): 0 | 3 | 4 {
  if (reasons.pending.length > 0) return 3;
  return reasons.unanalysed.length > 0 ? 4 : 0;
}

/** Every element of a `gh api --paginate --slurp` result, pages flattened. */
export function flatten(raw: string, key?: string): Read<unknown[]> {
  let pages: unknown;
  try {
    pages = JSON.parse(raw);
  } catch {
    return { ok: false, error: "the response is not JSON" };
  }
  if (!Array.isArray(pages))
    return { ok: false, error: "the response is not a list of pages" };
  const items: unknown[] = [];
  for (const page of pages) {
    const part = key === undefined ? page : isRecord(page) ? page[key] : null;
    if (!Array.isArray(part))
      return {
        ok: false,
        error: `a page has no ${key === undefined ? "list" : `'${key}' list`}`,
      };
    items.push(...part);
  }
  return { ok: true, value: items };
}
