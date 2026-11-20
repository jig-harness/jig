/** The first drives handed back by completed process-runtime pickups. */
import type { ReadRecord } from "./launches.ts";
import type { RepoTarget } from "./types.ts";

export type PickupArms = ReadonlyMap<number, ReadonlySet<string>>;

export function pickupArms(
  records: readonly ReadRecord[],
  repo: RepoTarget,
): PickupArms {
  const prs = new Map<number, Set<string>>();
  const prefix = `drive@${repo.slug}#`;
  for (const { record, state, result, next } of records) {
    const branch = record.workspace?.branch;
    if (
      record.runtime !== "process" ||
      record.action !== "pickup" ||
      record.repoPath !== repo.path ||
      record.repo !== repo.slug ||
      state.kind !== "ended" ||
      result !== "done" ||
      branch === undefined ||
      branch === "" ||
      next == null ||
      !("address" in next) ||
      !next.address.startsWith(prefix)
    )
      continue;
    const key = next.address.slice(prefix.length);
    const pr = Number(key);
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(pr)) continue;
    const branches = prs.get(pr) ?? new Set<string>();
    branches.add(branch);
    prs.set(pr, branches);
  }
  return prs;
}

/** The forge must name the branch the dispatcher opened in this same repository. */
export function pickupAsked(
  arms: PickupArms | undefined,
  pr: { number: number; headRefName: string; isCrossRepository?: boolean },
): boolean {
  return (
    pr.isCrossRepository === false &&
    arms?.get(pr.number)?.has(pr.headRefName) === true
  );
}
