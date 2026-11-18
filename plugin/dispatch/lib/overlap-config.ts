/**
 * `dispatch.overlap`: how the tick weighs the overlap between a pickup it
 * may start and the work already in flight (design/overlap-aware-admission.md).
 * Read from the default branch with the rest of the `dispatch` section, so a
 * pull request cannot loosen its own admission. An unknown key is refused,
 * as the section refuses one.
 *
 * | Key | Default | Meaning |
 * | --- | --- | --- |
 * | `max_per_file` | `4` | the overlap bound: the most pieces of work in flight that may change one file; `0` turns the bound off |
 * | `patience` | urgent `0`, high `30m`, medium `2h`, low and none `6h` | how long an overlapping pickup of each priority waits, per expected round, before it returns to tier 1 |
 * | `file_rate` | `0.5` | a path's conflict rate before enough merged pull requests changed it |
 * | `area_rate` | `0.2` | the rate of the one unit a directory or an area match counts as |
 * | `unknown_cost` | `0.5` | the overlap cost of a pickup whose footprint is unknown |
 * | `ignore` | none | globs of paths that count toward neither the cost nor the bound |
 * | `quiet_after` | `336h` (14 days) | a pull request with no change for this long counts toward the cost, not the bound |
 * | `bound_patience` | `24h` | how long a pickup over the bound waits before it is promoted to tier 1 |
 */
import { isMapping } from "../../shared/config-layers.ts";
import { globProblem } from "../../shared/glob.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { duration } from "./duration.ts";

/** A path's conflict rate before enough merged pull requests changed it (`file_rate`'s default). */
export const DEFAULT_FILE_RATE = 0.5;

/** The priorities patience is set for: the tracker's 1 (urgent) to 4 (low), and 0 (none). */
const PATIENCE_KEYS = ["urgent", "high", "medium", "low", "none"] as const;
export type PatienceKey = (typeof PATIENCE_KEYS)[number];

export interface OverlapSettings {
  maxPerFile: number;
  /** Milliseconds per expected round, by priority. */
  patienceMs: Record<PatienceKey, number>;
  fileRate: number;
  areaRate: number;
  unknownCost: number;
  ignore: string[];
  quietAfterMs: number;
  boundPatienceMs: number;
}

const HOUR_MS = 3_600_000;

export const DEFAULT_OVERLAP: OverlapSettings = {
  maxPerFile: 4,
  patienceMs: {
    urgent: 0,
    high: 30 * 60_000,
    medium: 2 * HOUR_MS,
    low: 6 * HOUR_MS,
    none: 6 * HOUR_MS,
  },
  fileRate: DEFAULT_FILE_RATE,
  areaRate: 0.2,
  unknownCost: 0.5,
  ignore: [],
  quietAfterMs: 14 * 24 * HOUR_MS,
  boundPatienceMs: 24 * HOUR_MS,
};

const KEYS = [
  "max_per_file",
  "patience",
  "file_rate",
  "area_rate",
  "unknown_cost",
  "ignore",
  "quiet_after",
  "bound_patience",
];

type Checked<T> = Outcome<T, "invalid">;

const invalid = (reason: string): Checked<never> => failed("invalid", reason);

/**
 * The refusal of a mapping's keys that `known` does not list, naming the
 * setting `where` and the keys it knows; `null` when every key is known. The
 * `dispatch` section and each mapping in it refuse an unknown key, since a
 * misspelt key would silently keep the default it was written to change.
 */
export function unknownKeys(
  where: string,
  value: Record<string, unknown>,
  known: readonly string[],
): Checked<never> | null {
  const unknown = Object.keys(value).filter((k) => !known.includes(k));
  return unknown.length === 0
    ? null
    : invalid(
        `${where} has unknown key(s): ${unknown.join(", ")} (known: ${known.join(", ")})`,
      );
}

/** The settings a section that names none of them, or a fixture built without them, reads as. */
export function overlapOf(section: {
  overlap?: OverlapSettings;
}): OverlapSettings {
  return section.overlap ?? DEFAULT_OVERLAP;
}

function share(value: unknown, key: string, fallback: number): Checked<number> {
  if (value === undefined || value === null) return ok(fallback);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    return invalid(`dispatch.overlap.${key} must be a number from 0 to 1`);
  return ok(value);
}

function maxPerFile(value: unknown): Checked<number> {
  if (value === undefined || value === null)
    return ok(DEFAULT_OVERLAP.maxPerFile);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid(
      "dispatch.overlap.max_per_file must be a whole number, 0 or more (0 turns the bound off)",
    );
  return ok(value);
}

function unknownCost(value: unknown): Checked<number> {
  if (value === undefined || value === null)
    return ok(DEFAULT_OVERLAP.unknownCost);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  )
    return invalid(
      "dispatch.overlap.unknown_cost must be a number from 0 to 100",
    );
  return ok(value);
}

/** A duration, or `0` (also `0s`, `0m`, `0h`) where `zero` allows it. */
function wait(
  value: unknown,
  key: string,
  fallback: number,
  zero: boolean,
): Checked<number> {
  if (value === undefined || value === null) return ok(fallback);
  if (
    zero &&
    (value === 0 ||
      (typeof value === "string" && /^0+\s*[smh]?$/.test(value.trim())))
  )
    return ok(0);
  return duration(value, `dispatch.overlap.${key}`);
}

function patience(value: unknown): Checked<Record<PatienceKey, number>> {
  const out = { ...DEFAULT_OVERLAP.patienceMs };
  if (value === undefined || value === null) return ok(out);
  if (!isMapping(value))
    return invalid(
      `dispatch.overlap.patience must be a mapping of priorities (${PATIENCE_KEYS.join(", ")}) to durations`,
    );
  const refused = unknownKeys(
    "dispatch.overlap.patience",
    value,
    PATIENCE_KEYS,
  );
  if (refused !== null) return refused;
  for (const key of PATIENCE_KEYS) {
    const read = wait(value[key], `patience.${key}`, out[key], true);
    if (!read.ok) return read;
    out[key] = read.value;
  }
  return ok(out);
}

function ignore(value: unknown): Checked<string[]> {
  if (value === undefined || value === null) return ok([]);
  if (
    !Array.isArray(value) ||
    value.some((g) => typeof g !== "string" || g.trim() === "")
  )
    return invalid("dispatch.overlap.ignore must be a list of path globs");
  for (const glob of value as string[]) {
    const problem = globProblem(glob);
    if (problem !== null)
      return invalid(
        `dispatch.overlap.ignore: ${glob} is not a glob: ${problem}`,
      );
  }
  return ok(value as string[]);
}

/** `dispatch.overlap`, with defaults; `invalid`, naming the key, for the first value that does not validate. */
export function parseOverlap(value: unknown): Checked<OverlapSettings> {
  if (value === undefined || value === null) return ok(DEFAULT_OVERLAP);
  if (!isMapping(value)) return invalid("dispatch.overlap must be a mapping");
  const refused = unknownKeys("dispatch.overlap", value, KEYS);
  if (refused !== null) return refused;
  const bound = maxPerFile(value.max_per_file);
  if (!bound.ok) return bound;
  const patienceMs = patience(value.patience);
  if (!patienceMs.ok) return patienceMs;
  const fileRate = share(
    value.file_rate,
    "file_rate",
    DEFAULT_OVERLAP.fileRate,
  );
  if (!fileRate.ok) return fileRate;
  const areaRate = share(
    value.area_rate,
    "area_rate",
    DEFAULT_OVERLAP.areaRate,
  );
  if (!areaRate.ok) return areaRate;
  const cost = unknownCost(value.unknown_cost);
  if (!cost.ok) return cost;
  const globs = ignore(value.ignore);
  if (!globs.ok) return globs;
  const quiet = wait(
    value.quiet_after,
    "quiet_after",
    DEFAULT_OVERLAP.quietAfterMs,
    false,
  );
  if (!quiet.ok) return quiet;
  const boundPatience = wait(
    value.bound_patience,
    "bound_patience",
    DEFAULT_OVERLAP.boundPatienceMs,
    false,
  );
  if (!boundPatience.ok) return boundPatience;
  return ok({
    maxPerFile: bound.value,
    patienceMs: patienceMs.value,
    fileRate: fileRate.value,
    areaRate: areaRate.value,
    unknownCost: cost.value,
    ignore: globs.value,
    quietAfterMs: quiet.value,
    boundPatienceMs: boundPatience.value,
  });
}

/** The patience key of a tracker priority: 0 none, 1 urgent to 4 low; anything else reads as none. */
export function patienceKey(priority: number | undefined): PatienceKey {
  switch (priority) {
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 3:
      return "medium";
    case 4:
      return "low";
    default:
      return "none";
  }
}
