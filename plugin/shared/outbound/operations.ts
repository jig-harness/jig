/**
 * The operation a call is recorded under in the cost ledger: a REST
 * route's shape or a GraphQL document's operation, never a repository name,
 * an id or a value the request carries. Every transport names its calls
 * this way, so the ledger groups them alike.
 */

/** A REST route's shape, without repository names, entity ids, queries or arbitrary path segments. */
export function restOperation(method: string, path: string): string {
  const safe = new Set([
    "repos",
    "repositories",
    "issues",
    "pulls",
    "comments",
    "comment",
    "reviews",
    "labels",
    "assignees",
    "commits",
    "checks",
    "check-runs",
    "statuses",
    "actions",
    "runs",
    "jobs",
    "rate_limit",
    "user",
    "users",
    "orgs",
    "teams",
    "members",
    "projects",
    "contents",
    "branches",
    "protection",
    "rulesets",
    "reactions",
    "timeline",
    "events",
    "artifacts",
    "attachments",
    "issue",
    "search",
    "jql",
    "field",
    "project",
    "myself",
    "status",
    "transitions",
    "priority",
    "issuetype",
    "resolution",
    "serverInfo",
  ]);
  const route =
    path
      .split("?")[0]
      ?.split("/")
      .filter(Boolean)
      .map((part) => (safe.has(part) ? part : "{}"))
      .join("/") ?? "";
  return `${method.toUpperCase()} /${route}`;
}

/**
 * A GraphQL document's named operation; for an anonymous one, its kind and
 * root field with `digest` of the document (twelve hex digits on a
 * machine), never a value it carries.
 */
export function queryOperation(
  query: string,
  digest: (text: string) => string,
): string {
  const clean = query.replace(/^\s*#.*$/gm, "");
  const named =
    /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
      clean,
    )?.[1];
  if (named) return named;
  const hash = digest(query);
  // Strip strings before looking for the selection, so an argument's text
  // cannot become the operation name. Keep the root field, never its values.
  const shape = clean.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const field =
    /\{\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)/.exec(
      shape,
    )?.[1];
  const kind = /^\s*mutation\b/.test(shape) ? "mutation" : "query";
  return field ? `${kind}:${field}-${hash}` : `anonymous-${hash}`;
}
