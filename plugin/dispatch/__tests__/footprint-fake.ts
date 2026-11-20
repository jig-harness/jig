/** The fake tracker's answer to the footprint port's batched comment query (`footprint-batch.ts`). */
import { conn } from "../../skills/do-item/__tests__/github-fixtures.ts";

/** The footprint port's batch of comment reads: each alias `b<i>` a repository root, every issue with no comment. */
export function footprintBatch(
  v: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(v)
      .filter(([name]) => /^b\d+_number$/.test(name))
      .map(([name, number]) => [
        name.replace(/_number$/, ""),
        { issue: { id: `i-${String(number)}`, comments: conn([]) } },
      ]),
  );
}
