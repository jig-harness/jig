/**
 * Drafts left behind: a document whose `status` is `draft` and whose
 * `last_updated` is older than the threshold. A warning, never a failure: the
 * owner decides whether to finish, promote or archive it.
 */
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Finding } from "./gates.ts";
import { isDate, markdownFiles, readFrontmatter } from "./docs.ts";
import { SettingsError } from "./settings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

/** Today in UTC; `LAST_UPDATED_TODAY` sets it, as it does for the stale-date gate. */
export function today(env: Record<string, string | undefined>): string {
  const given = env.LAST_UPDATED_TODAY;
  if (given !== undefined && given !== "") {
    if (!isDate(given))
      throw new SettingsError(
        `LAST_UPDATED_TODAY '${given}' is not a YYYY-MM-DD date`,
      );
    return given;
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * The stale drafts under `root`. A document whose frontmatter the reader
 * rejects, or whose date is not a calendar date, is left to the frontmatter
 * check, which reports it.
 */
export function staleDrafts(
  repo: string,
  root: string,
  afterDays: number,
  on: string,
): Finding[] {
  const found: Finding[] = [];
  for (const path of markdownFiles(join(repo, root)).sort()) {
    const frontmatter = readFrontmatter(readFileSync(path, "utf8"));
    if (frontmatter.errors.length || frontmatter.end < 0) continue;
    const status = frontmatter.fields.get("status");
    const date = frontmatter.fields.get("last_updated");
    if (status !== "draft" || typeof date !== "string" || !isDate(date))
      continue;
    const age = daysBetween(date, on);
    if (age <= afterDays) continue;
    found.push({
      file: relative(repo, path).split(sep).join("/"),
      check: "stale drafts",
      severity: "warning",
      message: `a draft last updated ${date}, ${age} days ago (more than ${afterDays}): finish and promote it, or archive it`,
    });
  }
  return found;
}
