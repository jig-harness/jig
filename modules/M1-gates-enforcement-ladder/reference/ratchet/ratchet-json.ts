import type { Counts } from "./ratchet-types.ts";

/** A counting command whose output cannot be read as counts. */
export class CountsError extends Error {}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A counting command's `{"counts": {"<rule>": {"<file>": n}}}`. Anything
 * else, a missing `counts` included, is refused: read as no findings it
 * would pass forever.
 */
export function parseCountsJson(stdout: string): Counts {
  const doc: unknown = JSON.parse(stdout);
  if (!isMapping(doc) || !isMapping(doc.counts))
    throw new CountsError('counting command printed no "counts" object');
  const counts: Counts = new Map();
  for (const [rule, files] of Object.entries(doc.counts)) {
    if (!isMapping(files))
      throw new CountsError(
        `counts for ${rule} are not a file-to-count object`,
      );
    for (const [file, n] of Object.entries(files)) {
      if (!Number.isSafeInteger(n) || (n as number) < 0)
        throw new CountsError(
          `count for ${rule} in ${file} is not a whole number`,
        );
      if (!n) continue;
      const perRule = counts.get(rule) ?? new Map<string, number>();
      perRule.set(file, n as number);
      counts.set(rule, perRule);
    }
  }
  return counts;
}

/**
 * What a json counter finds less of in the same tree under the head's
 * command than under its own: per rule, or per rule and file when the
 * counter compares per file, so a command that moves findings off one file
 * is caught too. Rule names are compared as printed, since they are the
 * command's own and carry no linter group to strip.
 */
export function lostCounts(
  own: Counts,
  underHead: Counts,
  perFile: boolean,
): { what: string; before: number; after: number }[] {
  const out: { what: string; before: number; after: number }[] = [];
  for (const [rule, files] of own) {
    const now = underHead.get(rule);
    if (perFile) {
      for (const [file, before] of files) {
        const after = now?.get(file) ?? 0;
        if (after < before)
          out.push({ what: `${rule} ${file}`, before, after });
      }
      continue;
    }
    const sum = (m: Map<string, number> | undefined) =>
      [...(m?.values() ?? [])].reduce((a, b) => a + b, 0);
    if (sum(now) < sum(files))
      out.push({ what: rule, before: sum(files), after: sum(now) });
  }
  return out;
}
