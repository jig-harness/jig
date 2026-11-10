/** The alert's own rule levels, independent of its review comment's text. */
import { readConfig } from "../../../../shared/consumer.ts";
import { DecodeError, isRecord } from "../../../../shared/guards.ts";

export type AlertSeverity = "blocker" | "high" | "medium" | "low";
const DEFAULTS: Readonly<Record<string, AlertSeverity>> = {
  critical: "blocker",
  high: "high",
  medium: "medium",
  low: "low",
  error: "high",
  warning: "medium",
  note: "low",
};

/** Partial overrides retain every level the repository did not name. */
export function parseCodeScanningSeverities(
  raw: unknown,
): Record<string, AlertSeverity> {
  if (raw === undefined || raw === null) return { ...DEFAULTS };
  if (!isRecord(raw))
    throw new DecodeError(
      "configuration",
      "review.code_scanning_severities",
      "must be a map",
    );
  for (const [key, value] of Object.entries(raw)) {
    if (
      !Object.hasOwn(DEFAULTS, key) ||
      typeof value !== "string" ||
      !["blocker", "high", "medium", "low"].includes(value)
    ) {
      throw new DecodeError(
        "configuration",
        "review.code_scanning_severities",
        `has an invalid mapping for ${key}`,
      );
    }
  }
  return { ...DEFAULTS, ...raw } as Record<string, AlertSeverity>;
}

export function codeScanningSeverities(): Record<string, AlertSeverity> {
  const review = readConfig().review;
  return parseCodeScanningSeverities(
    isRecord(review) ? review.code_scanning_severities : undefined,
  );
}
