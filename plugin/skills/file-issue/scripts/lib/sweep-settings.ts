/**
 * The weekly sweep's settings, `file_issue.sweep` in the repository's Jig
 * configuration: `move`, whether the sweep moves an incomplete issue back to
 * triage (the default) or only comments on it. An unknown key, or a value of
 * the wrong type, is refused rather than read as the default it was written
 * to change.
 */
import { withSource } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { SectionError } from "./sections.ts";

export interface SweepSettings {
  move: boolean;
}

/** `section`, a mapping holding only `keys`, or nothing when it is not set. */
function mapping(
  values: Record<string, unknown>,
  path: string,
  section: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (section === undefined || section === null) return null;
  if (!isRecord(section)) refuse(values, `${path} must be a mapping`);
  for (const key of Object.keys(section))
    if (!keys.includes(key)) refuse(values, `${path}.${key} is not a field`);
  return section;
}

function refuse(values: Record<string, unknown>, message: string): never {
  throw new SectionError(
    withSource(values, "file_issue", new Error(message)).message,
  );
}

/** The sweep's settings from the merged configuration `values`. */
export function sweepSettings(values: Record<string, unknown>): SweepSettings {
  const section = mapping(values, "file_issue", values.file_issue, ["sweep"]);
  const sweep = mapping(values, "file_issue.sweep", section?.sweep, ["move"]);
  const move = sweep?.move;
  if (move === undefined || move === null) return { move: true };
  if (typeof move !== "boolean")
    refuse(values, "file_issue.sweep.move must be true or false");
  return { move };
}
