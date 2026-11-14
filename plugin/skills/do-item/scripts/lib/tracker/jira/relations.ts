/** Interpret native Jira issue links with one repository's configured link types. */
import type { IssueRelation } from "../port.ts";
import type { RelationLink } from "./client.ts";
import type { JiraIssue } from "./read.ts";
import { LINKED_RELATIONS, type LinkedRelation } from "./settings.ts";

const SIDES: Record<
  LinkedRelation,
  [IssueRelation["type"], IssueRelation["type"]]
> = {
  blocks: ["blocks", "blocked_by"],
  duplicate: ["duplicate", "duplicated_by"],
  related: ["related", "related"],
};

export function relationsOf(
  issue: Pick<JiraIssue, "links">,
  types: Record<LinkedRelation, RelationLink[]>,
): IssueRelation[] {
  const out: IssueRelation[] = [];
  for (const link of issue.links)
    for (const relation of LINKED_RELATIONS) {
      const entry = types[relation].find(
        (type) =>
          type.name.trim().toLowerCase() === link.type.trim().toLowerCase(),
      );
      if (entry === undefined) continue;
      const forward = (link.direction === "outward") !== entry.inverted;
      out.push({ type: SIDES[relation][forward ? 0 : 1], issue: link.issue });
      break;
    }
  const ids = out.map((relation) => `${relation.type} ${relation.issue}`);
  return out.filter((_, index) => ids.indexOf(ids[index] as string) === index);
}
