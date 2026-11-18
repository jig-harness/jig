/**
 * The conflict rates the dispatcher keeps for each repository, under the
 * dispatch state directory, and their reader.
 *
 * `<dispatch>/conflict-rates/<repository>.json` is what `history.ts
 * --rates` last wrote whole (`merge-conflict-rates/v1`): for each path, the
 * merged pull requests of the window that changed it and how many of those
 * met a conflict before they merged. Beside it, `.cohort.json` keeps the
 * forge's listing of merged pull requests between runs, and `.refresh.json`
 * when the tick last tried to refresh them and how that ended
 * (`conflict-rates-refresh.ts`).
 *
 * A path's rate is the share of its observed merged pull requests that met
 * a conflict, once at least `MIN_OBSERVED` changed it, and
 * `DEFAULT_FILE_RATE` below that. A file that is missing, does not read or
 * is older than `STALE_AFTER_MS` leaves every rate at its default, and the
 * reading says why, so a receipt can carry it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errnoCode, swallow } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import {
  type PathRate,
  parseRates,
} from "../../skills/resolve-conflicts/scripts/lib/rates.ts";
import { stateRoot } from "../receipts.ts";

/** A path's rate below `MIN_OBSERVED` observed merged pull requests (`dispatch.overlap.file_rate`'s default). */
export const DEFAULT_FILE_RATE = 0.5;

/** The observed merged pull requests a path needs before its own share stands for its rate. */
export const MIN_OBSERVED = 5;

const DAY_MS = 86_400_000;

/** How old a rates file may be before it is stale: two daily refreshes missed. */
export const STALE_AFTER_MS = 2 * DAY_MS;

/** Where one repository's conflict rates, its kept listing and its refresh record live. */
export function ratesPaths(
  slug: string,
  root = stateRoot(),
): { dir: string; rates: string; cohort: string; refresh: string } {
  const dir = join(root, "conflict-rates");
  const base = join(dir, encodeURIComponent(slug));
  return {
    dir,
    rates: `${base}.json`,
    cohort: `${base}.cohort.json`,
    refresh: `${base}.refresh.json`,
  };
}

/** The tick's last refresh of a repository's rates: when it began, and how it ended. */
export interface RefreshRecord {
  version: 1;
  attemptedAt: string;
  /** `started` until the run ends: a run the host stopped never says more. */
  outcome: "started" | "written" | "kept";
  reason?: string;
}

/** The refresh record at `path`, or null when there is none or it does not read. */
export function readRefreshRecord(path: string): RefreshRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    swallow(
      err,
      "a refresh record that does not read is no record: the refresh is due",
    );
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.attemptedAt !== "string" ||
    !Number.isFinite(parseMs(value.attemptedAt)) ||
    !["started", "written", "kept"].includes(String(value.outcome))
  )
    return null;
  return {
    version: 1,
    attemptedAt: value.attemptedAt,
    outcome: value.outcome as RefreshRecord["outcome"],
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

export interface ConflictRates {
  slug: string;
  /** When the rates in use were measured; null when every rate is at its default. */
  generatedAt: string | null;
  /** Why every rate is at its default; null when the file stands. */
  defaulted: string | null;
  lastRefresh: RefreshRecord | null;
  /** A path's chance of meeting a conflict before it merges. */
  rate(path: string): number;
  /** How many observed merged pull requests changed the path in the window. */
  observed(path: string): number;
}

const DEFAULTED = `every path's rate is the default ${DEFAULT_FILE_RATE}`;

function defaults(
  slug: string,
  reason: string,
  lastRefresh: RefreshRecord | null,
): ConflictRates {
  const kept =
    lastRefresh?.outcome === "kept" && lastRefresh.reason !== undefined
      ? `; the last refresh, at ${lastRefresh.attemptedAt}, kept what was there: ${lastRefresh.reason}`
      : "";
  return {
    slug,
    generatedAt: null,
    defaulted: `${reason}: ${DEFAULTED}${kept}`,
    lastRefresh,
    rate: () => DEFAULT_FILE_RATE,
    observed: () => 0,
  };
}

/** One repository's conflict rates as the tick reads them at `nowMs`. */
export function readConflictRates(
  slug: string,
  nowMs: number,
  root = stateRoot(),
): ConflictRates {
  const paths = ratesPaths(slug, root);
  const lastRefresh = readRefreshRecord(paths.refresh);
  let text: string;
  try {
    text = readFileSync(paths.rates, "utf8");
  } catch (err) {
    const why =
      errnoCode(err) === "ENOENT"
        ? `no conflict rates for ${slug} have been measured yet`
        : `the conflict rates file for ${slug} does not read (${errnoCode(err) ?? "error"})`;
    return defaults(slug, why, lastRefresh);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    swallow(
      err,
      "a rates file that is not JSON leaves every rate at its default",
    );
    parsed = null;
  }
  const rates = parseRates(parsed);
  if (rates === null || rates.repository !== slug)
    return defaults(
      slug,
      `the conflict rates file for ${slug} does not read as merge-conflict-rates/v1`,
      lastRefresh,
    );
  const measured = parseMs(rates.generatedAt);
  if (nowMs - measured > STALE_AFTER_MS)
    return defaults(
      slug,
      `the conflict rates for ${slug}, measured at ${isoFromMs(measured)}, are stale (more than ${STALE_AFTER_MS / DAY_MS} days old)`,
      lastRefresh,
    );
  const byPath = new Map<string, PathRate>(rates.paths.map((p) => [p.path, p]));
  return {
    slug,
    generatedAt: rates.generatedAt,
    defaulted: null,
    lastRefresh,
    rate: (path) => {
      const p = byPath.get(path);
      return p === undefined || p.merged < MIN_OBSERVED
        ? DEFAULT_FILE_RATE
        : p.conflicted / p.merged;
    },
    observed: (path) => byPath.get(path)?.merged ?? 0,
  };
}
