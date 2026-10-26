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
 */
import { isRecord } from "../../../../shared/guards.ts";

/** The app whose annotations are read when `review.scanner_apps` is unset. */
export const DEFAULT_SCANNER_APPS: readonly string[] = ["sonarqubecloud"];

/** Annotation levels that are findings; `notice` is information. */
const FINDING_LEVELS = new Set(["warning", "failure"]);

/** One scanner annotation, as listed. */
export interface ScannerFinding {
  /** The app's slug (`sonarqubecloud`). */
  app: string;
  checkRunId: number;
  path: string;
  line: number;
  startLine: number | null;
  level: "warning" | "failure";
  /** The rule's message (`Do not use an object literal as default for …`). */
  title: string;
  /** The tool's own page for the finding, when the annotation links one. */
  url: string | null;
}

/** A scanner check run, with what is needed to read its annotations. */
export interface ScannerRun {
  id: number;
  app: string;
  completed: boolean;
  annotations: number;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** The check runs of `apps` (slugs, case-insensitive) among a commit's check runs. */
export function scannerRuns(
  checkRuns: unknown,
  apps: readonly string[],
): ScannerRun[] {
  const wanted = new Set(apps.map((a) => a.trim().toLowerCase()));
  const runs: ScannerRun[] = [];
  for (const raw of Array.isArray(checkRuns) ? checkRuns : []) {
    if (!isRecord(raw) || !isRecord(raw.app)) continue;
    const app = str(raw.app.slug)?.toLowerCase();
    const id = num(raw.id);
    if (app === undefined || id === null || !wanted.has(app)) continue;
    const output = isRecord(raw.output) ? raw.output : {};
    runs.push({
      id,
      app,
      completed: raw.status === "completed",
      annotations: num(output.annotations_count) ?? 0,
    });
  }
  return runs;
}

/** The first https link in an annotation's message: the tool's page for it. */
function linkOf(message: string | null): string | null {
  const m = message?.match(/https:\/\/[^\s)>"]+/);
  return m === null || m === undefined ? null : m[0];
}

/** The findings among one run's annotations; other levels and shapes drop out. */
export function findingsOf(
  run: ScannerRun,
  annotations: unknown,
): ScannerFinding[] {
  const found: ScannerFinding[] = [];
  for (const raw of Array.isArray(annotations) ? annotations : []) {
    if (!isRecord(raw)) continue;
    const level = str(raw.annotation_level);
    const path = str(raw.path);
    const line = num(raw.end_line) ?? num(raw.start_line);
    const title = str(raw.title) ?? str(raw.message);
    if (
      level === null ||
      !FINDING_LEVELS.has(level) ||
      path === null ||
      line === null ||
      title === null
    )
      continue;
    const start = num(raw.start_line);
    found.push({
      app: run.app,
      checkRunId: run.id,
      path,
      line,
      startLine: start !== null && start !== line ? start : null,
      level: level as ScannerFinding["level"],
      title,
      url: linkOf(str(raw.message)),
    });
  }
  return found;
}
