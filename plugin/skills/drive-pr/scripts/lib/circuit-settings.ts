/**
 * The round ceiling's settings: `drive.max_total_rounds`, the distinct
 * reviewed heads a pull request may spend across every launch, re-arm and
 * takeover, and `drive.max_wall_clock_hours`, the hours it may be driven
 * from its first launch. Both are read through the shared configuration
 * reader, and a value outside its range is an error naming where it was set.
 */
import { configSource } from "../../../../shared/consumer.ts";
import { DecodeError } from "../../../../shared/guards.ts";
import { readOptionalOverlay } from "./overlay.ts";

/** The round ceiling when `drive.max_total_rounds` is not set. */
export const DEFAULT_MAX_TOTAL_ROUNDS = 8;

/** The largest `drive.max_total_rounds` a repository may set. */
export const MAX_TOTAL_ROUNDS_BOUND = 50;

/** The least `drive.max_wall_clock_hours`: six minutes. */
export const MIN_WALL_CLOCK_HOURS = 0.1;

/** A setting's value and where it came from, as a stop names it. */
export interface SourcedSetting<T> {
  value: T;
  /** The configuration layer that set it, or `the default`. */
  source: string;
}

function driveField(name: string): unknown {
  const drive = readOptionalOverlay().drive;
  if (drive === undefined || drive === null) return undefined;
  if (typeof drive !== "object" || Array.isArray(drive))
    throw new DecodeError(
      configSource("drive"),
      "$.drive",
      "must be an object",
    );
  return (drive as Record<string, unknown>)[name];
}

/** `drive.max_total_rounds`, or the default; throws on a value outside 1 to 50. */
export function maxTotalRoundsSetting(): SourcedSetting<number> {
  const value = driveField("max_total_rounds");
  if (value === undefined || value === null)
    return { value: DEFAULT_MAX_TOTAL_ROUNDS, source: "the default" };
  const field = "drive.max_total_rounds";
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_TOTAL_ROUNDS_BOUND
  )
    throw new DecodeError(
      configSource(field),
      `$.${field}`,
      `must be a whole number from 1 to ${MAX_TOTAL_ROUNDS_BOUND}`,
    );
  return {
    value: value as number,
    source: `${field} (${configSource(field)})`,
  };
}

/** `drive.max_wall_clock_hours`, or `null` for no cap; throws on a value below 0.1 hours. */
export function maxWallClockHoursSetting(): SourcedSetting<number> | null {
  const value = driveField("max_wall_clock_hours");
  if (value === undefined || value === null) return null;
  const field = "drive.max_wall_clock_hours";
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_WALL_CLOCK_HOURS
  )
    throw new DecodeError(
      configSource(field),
      `$.${field}`,
      `must be a number of hours of at least ${MIN_WALL_CLOCK_HOURS}`,
    );
  return { value, source: `${field} (${configSource(field)})` };
}
