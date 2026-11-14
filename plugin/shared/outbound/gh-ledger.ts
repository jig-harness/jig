/** Account for forge commands at their shared runner, without keeping command arguments or query variables. */
import { credentialKey } from "./budget.ts";
import { isRecord } from "../guards.ts";
import { swallow } from "../errors.ts";
import { type GhRun, ghRunFailure, graphQLErrorsClass } from "./github.ts";
import { operationName } from "./ledger.ts";
import { recordAttempt, type Attempt } from "./record-attempt.ts";

function parsed(text: string): unknown {
  const body = text.replace(/^HTTP\/[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n/, "");
  try {
    return JSON.parse(body);
  } catch (error) {
    swallow(error, "an opaque GitHub command answer reports no query cost");
    return null;
  }
}

/** The points a GraphQL answer reports, including an error answer with partial data. */
export function githubCost(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const data = isRecord(body.data) ? body.data : body;
  const rate = data.rateLimit;
  return isRecord(rate) &&
    typeof rate.cost === "number" &&
    Number.isFinite(rate.cost) &&
    rate.cost >= 0
    ? rate.cost
    : null;
}

/** One field flag's value, including gh's joined short form. */
function fieldArgument(args: string[], index: number): string {
  const arg = args[index] ?? "";
  if (["-f", "--raw-field", "-F", "--field"].includes(arg))
    return args[index + 1] ?? "";
  return arg.startsWith("-fquery=") ? arg.slice(2) : "";
}

function commandQuery(
  args: string[],
  stdin: string | undefined,
): string | null {
  if (args[0] !== "api" || args[1] !== "graphql") return null;
  const body = stdin === undefined ? null : parsed(stdin);
  if (isRecord(body) && typeof body.query === "string") return body.query;
  for (let i = 0; i < args.length; i += 1) {
    const field = fieldArgument(args, i);
    if (field.startsWith("query=")) return field.slice(6);
  }
  return null;
}

/** A REST route's shape, without repository names, entity ids, queries or arbitrary path segments. */
export function restOperation(method: string, path: string): string {
  const safe = new Set([
    "repos",
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

function operation(args: string[], stdin: string | undefined): string {
  const query = commandQuery(args, stdin);
  if (query !== null) return operationName(query);
  if (args[0] === "api") {
    const methodAt = args.findIndex(
      (arg) => arg === "--method" || arg === "-X",
    );
    const method = methodAt < 0 ? "GET" : (args[methodAt + 1] ?? "GET");
    return restOperation(method, args[1] ?? "");
  }
  return (
    [args[0], args[1]]
      .filter((part) => part !== undefined && /^[a-z-]+$/.test(part))
      .join(" ") || "gh command"
  );
}

/** Each command invocation is an estimated request unless the answer reports query points. Local credential operations send none. */
export function recordGhAttempt<T extends GhRun, O>(
  args: string[],
  options: O,
  send: () => Promise<T>,
): Promise<T> {
  if (args[0] === "auth" || args[0] === "--help" || args[0] === "--version")
    return send();
  const opts = options as {
    stdin?: string;
    env?: Record<string, string | undefined>;
  };
  const env = opts.env ?? process.env;
  const credential = credentialKey(
    "github",
    env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || "opaque-cli-credential",
  );
  const observation: Attempt = {
    system: "github",
    credential,
    operation: operation(args, opts.stdin),
    requests: 0,
    cost: null,
    unit: args[0] === "api" && args[1] === "graphql" ? "points" : "requests",
    estimated: true,
  };
  return recordAttempt(
    observation,
    async () => {
      const began = Date.now();
      const result = await send();
      if (
        result.held === undefined &&
        !result.spawnFailed &&
        args[0] !== "auth" &&
        args[0] !== "--help" &&
        args[0] !== "--version"
      )
        observation.requests = 1;
      const stdout = (result as GhRun & { stdout?: unknown }).stdout;
      const hasOutput = typeof stdout === "string";
      const body = hasOutput ? parsed(stdout) : null;
      const cost = githubCost(body);
      observation.cost =
        cost ??
        (hasOutput && observation.requests > 0
          ? args[0] === "api" && args[1] === "rate_limit"
            ? 0
            : 1
          : null);
      observation.estimated = hasOutput && cost === null;
      const run =
        typeof result.stderr === "string" && typeof result.code === "number"
          ? ghRunFailure(result, Date.now() - began)
          : null;
      if (run !== null) return { result, failure: run.code };
      const failure =
        isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0
          ? graphQLErrorsClass(
              body.errors.map((e) =>
                isRecord(e) && typeof e.type === "string" ? e.type : "",
              ),
            )
          : null;
      return { result, failure };
    },
    (answer) => answer.failure,
  ).then((answer) => answer.result);
}
