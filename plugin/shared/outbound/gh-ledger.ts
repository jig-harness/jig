/** Account for forge commands at their shared runner, without keeping command arguments or query variables. */
import { apiRoute, conditional, githubCredential } from "./github-budget.ts";
import { isRecord } from "../guards.ts";
import { swallow } from "../errors.ts";
import {
  type GhRun,
  ghResponseStatus,
  ghRunFailure,
  graphQLErrorsClass,
} from "./github.ts";
import { operationName } from "./ledger.ts";
import { recordAttempt, type Attempt } from "./record-attempt.ts";
import { currentMs } from "../time.ts";

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
  if (args[0] !== "api" || apiRoute(args) !== "graphql") return null;
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
    return restOperation(method, apiRoute(args));
  }
  return (
    [args[0], args[1]]
      .filter((part) => part !== undefined && /^[a-z-]+$/.test(part))
      .join(" ") || "gh command"
  );
}

interface CaptureOptions {
  stdin?: string;
  env?: Record<string, string | undefined>;
  stdout?: string;
  onOutput?: unknown;
}

/** A whole captured answer; inherited, streamed and absent output carries no measurement. */
function capturedOutput(
  result: GhRun & { stdout?: unknown },
  opts: CaptureOptions,
): string | null {
  if ((opts.stdout ?? "pipe") !== "pipe" || opts.onOutput !== undefined)
    return null;
  return typeof result.stdout === "string" ? result.stdout : null;
}

/** Whether a single captured conditional REST response was charged primary quota. */
function conditionalCost(args: string[], result: GhRun): number | null {
  if (
    args[0] !== "api" ||
    apiRoute(args) === "graphql" ||
    args.includes("--paginate") ||
    !conditional(args)
  )
    return null;
  // Status evidence came from governance before stripping or caller-requested headers.
  if (
    result.httpStatus === undefined &&
    !args.some((arg) => arg === "-i" || arg === "--include")
  )
    return null;
  const status = ghResponseStatus(result);
  if (status === 304) return 0;
  return status === 200 ? 1 : null;
}

function estimatedCost(
  args: string[],
  sent: number,
  output: string | null,
): number | null {
  if (output === null || sent === 0) return null;
  return args[0] === "api" && apiRoute(args) === "rate_limit" ? 0 : 1;
}

/** Keep request traffic separate from measured primary cost and opaque command estimates. */
function accountAnswer(
  observation: Attempt,
  args: string[],
  result: GhRun,
  opts: CaptureOptions,
): unknown {
  observation.requests =
    result.held === undefined && !result.spawnFailed ? 1 : 0;
  const output = capturedOutput(result, opts);
  const body = output === null ? null : parsed(output);
  const reported = githubCost(body);
  // gh authenticates its API calls; 304 confirms this conditional read was free.
  const conditional = output === null ? null : conditionalCost(args, result);
  observation.cost =
    reported ??
    conditional ??
    estimatedCost(args, observation.requests, output);
  observation.estimated =
    output !== null && reported === null && conditional === null;
  return body;
}

function bodyFailure(body: unknown) {
  if (
    !isRecord(body) ||
    !Array.isArray(body.errors) ||
    body.errors.length === 0
  )
    return null;
  return graphQLErrorsClass(
    body.errors.map((e) =>
      isRecord(e) && typeof e.type === "string" ? e.type : "",
    ),
  );
}

/** Captured conditional status or query points determine cost; opaque commands remain estimated. Local credential operations send none. */
export function recordGhAttempt<T extends GhRun, O>(
  args: string[],
  options: O,
  send: () => Promise<T>,
): Promise<T> {
  if (args[0] === "auth" || args[0] === "--help" || args[0] === "--version")
    return send();
  const opts = options as CaptureOptions;
  const credential = githubCredential(opts.env ?? process.env);
  const observation: Attempt = {
    system: "github",
    credential,
    operation: operation(args, opts.stdin),
    requests: 0,
    cost: null,
    unit:
      args[0] === "api" && apiRoute(args) === "graphql" ? "points" : "requests",
    estimated: true,
  };
  return recordAttempt(
    observation,
    async () => {
      const began = currentMs();
      const result = await send();
      const body = accountAnswer(observation, args, result, opts);
      const run =
        typeof result.stderr === "string" && typeof result.code === "number"
          ? ghRunFailure(result, currentMs() - began)
          : null;
      if (run !== null) return { result, failure: run.code };
      return { result, failure: bodyFailure(body) };
    },
    (answer) => answer.failure,
  ).then((answer) => answer.result);
}
