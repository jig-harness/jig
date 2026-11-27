/** The proposal's command-line values and its pool's de-duplication, read the same way by every mode. */
import type { PoolIssue } from "../../../do-item/scripts/lib/tracker/port.ts";
import { Refusal } from "./errors.ts";

/** `--<flag>`'s whole number, `fallback` when absent; any other value is refused with `usage`. */
export function positiveInteger(
  raw: string | undefined,
  flag: string,
  fallback: number,
  usage: string,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Refusal(
      `--${flag} must be a positive whole number, got "${raw}"\n${usage}`,
    );
  return n;
}

/** A comma-separated list of keys, blanks dropped. */
export function claimedSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

export async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Keep the first of each identifier: a pool read twice can return an issue twice. */
export function unique(issues: readonly PoolIssue[]): PoolIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.identifier)) return false;
    seen.add(i.identifier);
    return true;
  });
}
