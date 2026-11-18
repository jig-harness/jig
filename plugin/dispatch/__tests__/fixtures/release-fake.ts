/** The dispatch test world's tracker answers specific to releases. */
import { conn, issueNode } from "../../../skills/do-item/__tests__/github-fixtures.ts";

export function releaseTrackerAnswer(
  op: string | undefined,
  v: Record<string, unknown>,
  issues: Array<Record<string, unknown>>,
  repo: string,
): unknown {
  if (
    op === "TrackerSearch" &&
    typeof v.q === "string" &&
    v.q.includes("owes a tag")
  ) {
    const q = v.q;
    const found = issues.filter(
      (node) =>
        typeof node.title === "string" &&
        q.endsWith(JSON.stringify(node.title)),
    );
    return { search: { ...conn(found), issueCount: found.length } };
  }
  if (op === "TrackerLabels")
    return {
      repository: {
        labels: conn([
          { id: "L_priority_high", name: "priority: high" },
          { id: "L_task", name: "task" },
        ]),
      },
    };
  if (
    op === "TrackerCreate" &&
    typeof v.input === "object" &&
    v.input !== null &&
    "title" in v.input &&
    typeof v.input.title === "string" &&
    v.input.title.startsWith(`Release ${repo} `) &&
    v.input.title.endsWith("owes a tag")
  ) {
    const created = issueNode({
      number: 42,
      title: v.input.title,
      repo,
    });
    issues.push(created);
    return {
      createIssue: { issue: { number: created.number, url: created.url } },
    };
  }
  return undefined;
}
