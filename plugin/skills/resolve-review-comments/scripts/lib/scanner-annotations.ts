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
 * Evidence that cannot be read is never read as a clean scan. Every field that
 * decides whether something is a finding (a run's app, an annotation's level,
 * its lines, how many annotations a run holds) is checked against the values
 * it can take, and one outside them makes the response an error rather than
 * something to skip: a run whose app cannot be read is not another app's, a
 * level GitHub does not define is not a notice, and an annotation list shorter
 * or longer than the count the completed run reports is not complete, nor is a
 * check-run listing with no page or one whose pages do not hold the total they
 * report. A run
 * whose annotation count is unreadable has its annotations fetched anyway, and
 * a run that completed without analysing the head is reported as such.
 */
import { createHash } from "node:crypto";
import { isRecord } from "../../../../shared/guards.ts";

/** The app whose annotations are read when `review.scanner_apps` is unset. */
export const DEFAULT_SCANNER_APPS: readonly string[] = ["sonarqubecloud"];

/** The annotation levels GitHub defines. */
const LEVELS = new Set(["notice", "warning", "failure"]);

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

/** A line number, which starts at 1: `undefined` when absent, `null` when malformed. */
const lineNo = (v: unknown): number | null | undefined =>
  v === undefined || v === null
    ? undefined
    : typeof v === "number" && Number.isSafeInteger(v) && v >= 1
      ? v
      : null;

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

const ok = <T>(value: T): Read<T> => ({ ok: true, value });

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

/** A wanted check run's id, whether it completed, and its conclusion once it has. */
function stateOf(
  raw: Record<string, unknown>,
  app: string,
  i: number,
): Read<Pick<ScannerRun, "id" | "completed" | "conclusion">> {
  const id = num(raw.id);
  const status = str(raw.status);
  if (id === null || status === null)
    return fail(`the ${app} check run ${i} has no id or status`);
  const completed = status === "completed";
  const conclusion = completed ? str(raw.conclusion) : null;
  if (completed && conclusion === null)
    return fail(`the ${app} check run ${id} completed with no conclusion`);
  return ok({ id, completed, conclusion });
}

/** One check run, when it is one of `wanted`'s. */
function runOf(
  raw: unknown,
  i: number,
  wanted: ReadonlySet<string>,
): ScannerRun | null | string {
  if (!isRecord(raw)) return `check run ${i} is not an object`;
  const slug = isRecord(raw.app) ? str(raw.app.slug) : null;
  if (slug === null) return `check run ${i}'s app has no slug`;
  const app = slug.toLowerCase();
  if (!wanted.has(app)) return null;
  const state = stateOf(raw, app, i);
  if (!state.ok) return state.error;
  const output = isRecord(raw.output) ? raw.output : {};
  return { ...state.value, app, annotations: num(output.annotations_count) };
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

/**
 * A hash of what identifies the finding across heads: its file and text, the
 * message included, since it carries the tool's issue key where the tool links
 * one. The line is left out, so the identity survives an edit that moves the
 * finding.
 */
function fingerprintOf(app: string, path: string, text: string): string {
  const digest = createHash("sha256")
    .update(`${path}\0${text}`)
    .digest("hex")
    .slice(0, 16);
  return `${app}-${digest}`;
}

/**
 * The findings with one fingerprint per occurrence. Findings that share file
 * and text are told apart by their order in the file: the first keeps the
 * hash, the n-th takes `-n`, so each is answered on its own, and an edit that
 * moves them without reordering them keeps every identity.
 */
function byOccurrence(findings: ScannerFinding[]): ScannerFinding[] {
  const seen = new Map<string, number>();
  const ordered = [...findings].sort(
    (a, b) =>
      a.line - b.line || (a.startLine ?? a.line) - (b.startLine ?? b.line),
  );
  const nth = new Map<ScannerFinding, number>();
  for (const f of ordered) {
    const n = (seen.get(f.fingerprint) ?? 0) + 1;
    seen.set(f.fingerprint, n);
    nth.set(f, n);
  }
  return findings.map((f) => {
    const n = nth.get(f) ?? 1;
    return n === 1 ? f : { ...f, fingerprint: `${f.fingerprint}-${n}` };
  });
}

/** An annotation's level when it is a finding; `null` for a `notice`. */
function levelOf(
  raw: Record<string, unknown>,
  where: string,
): Read<ScannerFinding["level"] | null> {
  const level = str(raw.annotation_level);
  if (level === null) return fail(`${where} has no level`);
  if (!LEVELS.has(level))
    return fail(`${where} has an unknown level '${level}'`);
  return ok(
    FINDING_LEVELS.has(level) ? (level as ScannerFinding["level"]) : null,
  );
}

/** An annotation's last line and, for a range, its first. */
function linesOf(
  raw: Record<string, unknown>,
  where: string,
): Read<Pick<ScannerFinding, "line" | "startLine">> {
  const start = lineNo(raw.start_line);
  const end = lineNo(raw.end_line);
  if (start === null || end === null)
    return fail(`${where} has a line that is not a whole number from 1`);
  const line = end ?? start;
  if (line === undefined) return fail(`${where} has no line`);
  if (start !== undefined && start > line)
    return fail(`${where} ends on line ${line}, before it starts (${start})`);
  return ok({
    line,
    startLine: start === undefined || start === line ? null : start,
  });
}

/** One annotation as a finding; `null` for a `notice`. */
function findingOf(
  run: ScannerRun,
  raw: unknown,
  i: number,
): ScannerFinding | null | string {
  const where = `check run ${run.id}'s annotation ${i}`;
  if (!isRecord(raw)) return `${where} is not an object`;
  const level = levelOf(raw, where);
  if (!level.ok) return level.error;
  if (level.value === null) return null;
  const lines = linesOf(raw, where);
  if (!lines.ok) return lines.error;
  const path = str(raw.path);
  const text = textOf(raw);
  if (path === null || text === null)
    return `${where} is a ${level.value} with no path or text`;
  return {
    app: run.app,
    checkRunId: run.id,
    path,
    ...lines.value,
    level: level.value,
    title: text.title,
    message: text.message,
    url: text.url,
    fingerprint: fingerprintOf(run.app, path, text.identity),
  };
}

/**
 * An annotation's title (its message where it has none), its message where it
 * says more, the link in it, and the text that identifies it.
 */
function textOf(raw: Record<string, unknown>): {
  title: string;
  message: string | null;
  url: string | null;
  identity: string;
} | null {
  const message = str(raw.message);
  const title = str(raw.title) ?? message;
  if (title === null) return null;
  return {
    title,
    message: message?.trim() === title ? null : message,
    url: linkOf(message),
    identity: `${title}\0${message}`,
  };
}

/**
 * The findings among one run's annotations; `notice` annotations drop out. A
 * completed run's list must hold exactly the count the run reports, notices
 * included; a running one's may still grow, and its listing is pending anyway.
 */
export function findingsOf(
  run: ScannerRun,
  annotations: unknown,
): Read<ScannerFinding[]> {
  if (
    run.completed &&
    run.annotations !== null &&
    Array.isArray(annotations) &&
    annotations.length !== run.annotations
  )
    return {
      ok: false,
      error: `check run ${run.id} reports ${run.annotations} annotation(s) but lists ${annotations.length}`,
    };
  const found = collect(
    annotations,
    `check run ${run.id}'s annotations`,
    (raw, i) => findingOf(run, raw, i),
  );
  return found.ok ? ok(byOccurrence(found.value)) : found;
}

/** GitHub lists a commit's check runs from its most recent check suites only, this many. */
export const LISTED_SUITES = 1000;

/**
 * The head's check suite count, read from `total_count`, when the check-run
 * listing covers every suite; past the bound a scanner's run may be missing
 * from the listing, which would read as the default app not running here.
 */
export function suitesCovered(raw: string): Read<number> {
  const text = raw.trim();
  const n = /^[0-9]+$/.test(text) ? num(Number(text)) : null;
  if (n === null)
    return {
      ok: false,
      error: `the check suite count '${text}' is not a number`,
    };
  if (n > LISTED_SUITES)
    return {
      ok: false,
      error: `the head has ${n} check suites, and GitHub lists check runs from the ${LISTED_SUITES} most recent only`,
    };
  return { ok: true, value: n };
}

/** The exit a listing ends with: 3 while unsettled, 4 when a run did not analyse, else 0. */
export function exitFor(reasons: {
  pending: readonly string[];
  unanalysed: readonly string[];
}): 0 | 3 | 4 {
  if (reasons.pending.length > 0) return 3;
  return reasons.unanalysed.length > 0 ? 4 : 0;
}

/**
 * Every element of a `gh api --paginate --slurp` result, pages flattened. A
 * result with no page received nothing. With `key`, each page is GitHub's
 * envelope: its list under `key` and the listing's `total_count`, which every
 * page must report alike and the pages together must hold exactly.
 */
export function flatten(raw: string, key?: string): Read<unknown[]> {
  const pages = pagesOf(raw);
  if (!pages.ok) return pages;
  const items: unknown[] = [];
  const totals = new Set<number | null>();
  for (const page of pages.value) {
    const read = pageOf(page, key);
    if (!read.ok) return read;
    items.push(...read.value.items);
    totals.add(read.value.total);
  }
  return whole(items, [...totals], key);
}

/** The pages of a `--slurp` result: at least one. */
function pagesOf(raw: string): Read<unknown[]> {
  let pages: unknown;
  try {
    pages = JSON.parse(raw);
  } catch {
    return fail("the response is not JSON");
  }
  if (!Array.isArray(pages)) return fail("the response is not a list of pages");
  return pages.length === 0 ? fail("the response holds no page") : ok(pages);
}

/** One page's list and, under `key`, the total its envelope reports. */
function pageOf(
  page: unknown,
  key: string | undefined,
): Read<{ items: unknown[]; total: number | null }> {
  if (key === undefined)
    return Array.isArray(page)
      ? ok({ items: page, total: null })
      : fail("a page has no list");
  const items = isRecord(page) ? page[key] : null;
  if (!isRecord(page) || !Array.isArray(items))
    return fail(`a page has no '${key}' list`);
  const total = num(page.total_count);
  return total === null
    ? fail("a page has no readable 'total_count'")
    : ok({ items, total });
}

/** The listing, once its pages agree on one total and hold exactly that many. */
function whole(
  items: unknown[],
  totals: (number | null)[],
  key: string | undefined,
): Read<unknown[]> {
  if (totals.length > 1)
    return fail(`the pages report different totals (${totals.join(", ")})`);
  const total = totals[0] ?? null;
  if (total !== null && items.length !== total)
    return fail(
      `the listing reports ${total} '${key}' but holds ${items.length}`,
    );
  return ok(items);
}
