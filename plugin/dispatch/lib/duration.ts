/** A duration setting of the machine file or a repository's `dispatch` section, read into milliseconds, and a span written in whole minutes. */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
/** The longest duration any setting takes: inside the 2,147,483,647 ms a timer holds, which the deadlines of child processes are armed with. */
const MAX_DURATION_MS = 24 * 86_400_000;

/** A duration such as `90s`, `5m` or `1h`, in milliseconds; `invalid` names `where` when it is not one. */
export function duration(
  value: unknown,
  where: string,
): Outcome<number, "invalid"> {
  const match =
    typeof value === "string" ? /^(\d+)\s*([smh])$/.exec(value.trim()) : null;
  const ms = match ? Number(match[1]) * (UNITS[match[2] as string] ?? 0) : 0;
  if (!match || ms <= 0 || ms > MAX_DURATION_MS)
    return failed(
      "invalid",
      `${where} must be a positive duration such as 90s, 5m or 1h, at most 24d`,
    );
  return ok(ms);
}

/** A span as the reports write it: whole minutes, rounded down (`90m`). */
export function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}
