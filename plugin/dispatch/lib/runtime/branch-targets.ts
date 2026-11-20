import { keyFromBranch } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { JoinTargets } from "./port.ts";

/** What a branch names: the pull request whose head it is, the item whose key it carries. */
export function branchTargets(branch: string, join: JoinTargets) {
  if (branch === "") return { prs: [], items: [] };
  const key =
    join.keys === null
      ? null
      : keyFromBranch(branch, join.keys, join.branchPattern);
  return {
    prs: join.pullRequests
      .filter((pr) => pr.head === branch)
      .map((pr) => pr.number),
    items: key === null ? [] : [key],
  };
}
