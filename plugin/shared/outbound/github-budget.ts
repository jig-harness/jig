/**
 * GitHub's limits in the machine's budget record (`budget.ts`): the profile
 * that says which limits GitHub has and how it reports and refuses them, and
 * the governance every run of the `gh` command-line client goes through at
 * the forge client's wrapper (`shared/trace.ts`).
 *
 * Before a run, the wrapper admits it against the credential's record: while
 * GitHub refuses the credential (a primary or a secondary limit), or while
 * the dispatcher's share of the limit the run spends is used, the run is not
 * started and fails at once as `rate-limited`, naming when it clears. After
 * a run, the wrapper records what its answer said:
 *
 * - a `gh api` call is sent with `--include`, so its answer carries the
 *   rate-limit headers (`x-ratelimit-resource`, `-limit`, `-remaining`,
 *   `-reset`, and `retry-after` on a refusal); the headers are taken off
 *   the output before the caller reads it;
 * - a GraphQL answer that selects `rateLimit` says the GraphQL balance;
 * - the `rate_limit` endpoint, which costs nothing against the primary
 *   limits, says every limit's balance;
 * - a primary limit the headers name as spent holds that limit until its
 *   reset; a secondary limit, or a refusal that shows no headers, holds the
 *   credential for every process on the machine: until its `retry-after`,
 *   else for a minute, doubled for each refusal in a row, up to fifteen;
 * - the `rate_limit` endpoint's answer replaces the balances the record
 *   holds, and a request that was not sent or that GitHub does not charge
 *   (a conditional request) keeps no reservation.
 *
 * The other subcommands (`gh pr view`, `gh issue list`) show no headers:
 * each reserves a point of the GraphQL balance, the least a query costs, so
 * the share still moves toward its floor, and the balance they spend is read
 * from the `rate_limit` endpoint, which the tick asks at most once, and from
 * their refusals' text. A refusal's caller is told the wait the record holds.
 *
 * `JIG_FORGE_BUDGET=off` leaves every run ungoverned: nothing is admitted,
 * observed or added to the command line. The test suites set it, so a
 * fixture's fake refusal does not hold the forge for the tests after it.
 */
import {
  type AdmitOptions,
  type BudgetAnswer,
  type BudgetGovernor,
  type BudgetRecord,
  type BudgetWindow,
  budgetGovernor,
  credentialKey,
  isRateLimited,
  sqliteBudgetStore,
} from "./budget.ts";
import { swallow } from "../errors.ts";
import { isRecord } from "../guards.ts";
import {
  type OutboundFailure,
  outboundFailure,
  retryAfterMs,
} from "./failure.ts";
import { type GhRun, ghResponseStatus, ghRunFailure } from "./github.ts";
import { defaultLedgerPath } from "./ledger.ts";
import { currentMs, parseMs } from "../time.ts";

/** One of GitHub's primary limits, as `x-ratelimit-resource` names it. */
export type GitHubLimit = "core" | "graphql" | "search";

/** What a transport profile declares of one limit; never a number GitHub reports. */
interface LimitProfile {
  /** The unit the limit counts. */
  unit: "requests" | "points";
  /** How it refills: whole, at the reset the answer names. */
  refill: "whole";
  /** The record's window it is kept under. */
  window: string;
  /** How long one window of it lasts. */
  periodMs: number;
}

/**
 * GitHub's profile: its primary limits, each kept in a window of the
 * credential's record, and what its refusals look like. The quota owner is
 * the credential.
 */
const GITHUB_PROFILE = {
  system: "github",
  owner: "credential",
  limits: {
    core: {
      unit: "requests",
      refill: "whole",
      window: "requests",
      periodMs: 3_600_000,
    },
    graphql: {
      unit: "points",
      refill: "whole",
      window: "complexity",
      periodMs: 3_600_000,
    },
    search: {
      unit: "requests",
      refill: "whole",
      window: "search",
      periodMs: 60_000,
    },
  } satisfies Record<GitHubLimit, LimitProfile>,
  /**
   * A refusal: 403 or 429 (or a GraphQL `RATE_LIMITED` error) with no
   * requests remaining, or a secondary limit, with `retry-after` when GitHub
   * sends one; `github.ts` reads which.
   */
  secondary: {
    /** The hold of a refusal that names no wait, doubled for each in a row. */
    floorMs: 60_000,
    /** The longest such a hold grows to. */
    capMs: 15 * 60_000,
  },
} as const;

/** What each window of a GitHub record holds, for a person reading the record. */
export const GITHUB_WINDOW_NAMES: Readonly<Record<string, GitHubLimit>> = {
  requests: "core",
  complexity: "graphql",
  search: "search",
};

/**
 * The key the credential's record and its ledger rows are kept under: a
 * hash of the token the client sends, or for the client's own stored login,
 * of the host and configuration it reads it from. A stored login is opaque:
 * the same token supplied through the environment keys a separate record, and
 * a host named only on a command line is not an input here.
 */
export function githubCredential(
  env: Record<string, string | undefined> = process.env,
): string {
  const host = env.GH_HOST?.trim() ?? "";
  // The client reads the Enterprise variables for an Enterprise Server host,
  // and the others for github.com and its cloud and local tenancies.
  const name = host.toLowerCase();
  const enterprise =
    host !== "" &&
    name !== "github.com" &&
    !name.endsWith(".ghe.com") &&
    !name.endsWith(".github.localhost") &&
    name !== "github.localhost";
  const token = enterprise
    ? env.GH_ENTERPRISE_TOKEN?.trim() || env.GITHUB_ENTERPRISE_TOKEN?.trim()
    : env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (token) return credentialKey("github", token);
  const config = env.GH_CONFIG_DIR?.trim() ?? "";
  return credentialKey(
    "github",
    host === "" && config === ""
      ? "opaque-cli-credential"
      : `opaque-cli-credential:${host}:${config}`,
  );
}

/** Which limits a run of `gh` with `args` spends: `[]` for one that spends none, `null` for one that sends nothing. */
export function limitsOf(args: readonly string[]): GitHubLimit[] | null {
  const [command] = args;
  if (
    command === undefined ||
    [
      "auth",
      "--help",
      "--version",
      "help",
      "version",
      "config",
      "alias",
      "completion",
      "extension",
    ].includes(command)
  )
    return null;
  if (command !== "api") return ["core", "graphql"];
  const route = apiRoute(args);
  if (route === "graphql") return ["graphql"];
  if (route === "rate_limit") return [];
  if (route === "search" || route.startsWith("search/")) return ["search"];
  return ["core"];
}

/** `gh api`'s flags that take a value, which is never the route. */
const VALUED = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** The route a `gh api` command line asks: its first argument that is neither a flag nor a flag's value, without a leading slash or a query. */
export function apiRoute(args: readonly string[]): string {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (VALUED.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg.replace(/^\/+/, "").split("?")[0] ?? "";
  }
  return "";
}

/** A request GitHub answers 304 without charging it, when nothing changed; a 200 to it is charged like any other. */
export function conditional(args: readonly string[]): boolean {
  return args.some((arg, i) => {
    const header =
      args[i - 1] === "-H" || args[i - 1] === "--header"
        ? arg
        : arg.startsWith("--header=")
          ? arg.slice("--header=".length)
          : arg.startsWith("-H") && arg !== "-H"
            ? arg.slice(2).replace(/^=/, "")
            : null;
    return (
      header !== null && /^\s*if-(none-match|modified-since)\s*:/i.test(header)
    );
  });
}

/**
 * What the run is admitted against: the windows of the limits it spends.
 * It reserves one request of a REST limit, except for a conditional request
 * whose answer's headers are read (`readable`): they say whether it was
 * charged. It reserves one point of the GraphQL balance for a run whose
 * answer may not report its cost: a query costs at least a point, so the
 * share still moves toward its floor when no answer says the balance.
 */
function admission(
  limits: readonly GitHubLimit[],
  args: readonly string[],
  readable: boolean,
): AdmitOptions {
  const windows = limits.map((l) => GITHUB_PROFILE.limits[l].window);
  const only = limits.length === 1 ? limits[0] : undefined;
  const spent: GitHubLimit | null =
    only !== undefined && GITHUB_PROFILE.limits[only].unit === "requests"
      ? conditional(args) && readable
        ? null
        : only
      : limits.includes("graphql")
        ? "graphql"
        : null;
  if (spent === null) return { windows, reserve: null };
  const profile = GITHUB_PROFILE.limits[spent];
  return { windows, reserve: profile.window, rollMs: profile.periodMs };
}

const INCLUDE = new Set(["-i", "--include"]);
/** Flags whose output the headers cannot be taken off: several answers, none, or a trace. */
const NO_INCLUDE = new Set(["--paginate", "--silent", "--verbose"]);

/** Whether the caller asked for the headers itself. */
function askedHeaders(args: readonly string[]): boolean {
  return args.some((a) => INCLUDE.has(a));
}

/** The command line with `--include` added where the answer's headers can be read and taken off; the same line otherwise. */
export function withHeaders(
  args: readonly string[],
  captured: boolean,
): { argv: string[]; strip: boolean } {
  if (args[0] !== "api" || askedHeaders(args))
    return { argv: [...args], strip: false };
  if (!captured || args.some((a) => NO_INCLUDE.has(a)))
    return { argv: [...args], strip: false };
  return { argv: [...args, "--include"], strip: true };
}

/** The headers `gh api --include` printed before the body, and the body; `null` headers when it printed none. */
export function splitHeaders(stdout: string): {
  headers: Headers | null;
  body: string;
} {
  if (!stdout.startsWith("HTTP/")) return { headers: null, body: stdout };
  const end = /\r?\n\r?\n/.exec(stdout);
  const block = end === null ? stdout : stdout.slice(0, end.index);
  const body = end === null ? "" : stdout.slice(end.index + end[0].length);
  const headers = new Headers();
  for (const line of block.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch (error) {
      swallow(
        error,
        "a header line that does not read says nothing of the limits",
      );
    }
  }
  return { headers, body };
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

function windowOf(
  limit: unknown,
  remaining: unknown,
  resetAt: number | null,
): BudgetWindow | null {
  const l = count(limit);
  const r =
    typeof remaining === "number" && Number.isFinite(remaining)
      ? remaining
      : null;
  if (r === null || resetAt === null) return null;
  return { limit: l, remaining: r, resetAt };
}

/** Put a limit's window where the record keeps it. */
function place(answer: BudgetAnswer, resource: string, w: BudgetWindow): void {
  const known = (GITHUB_PROFILE.limits as Record<string, LimitProfile>)[
    resource
  ];
  const name = known?.window ?? resource;
  if (name === "requests") answer.requests = w;
  else if (name === "complexity") answer.complexity = w;
  else answer.windows = { ...answer.windows, [name]: w };
}

/** A header's number; `null` when the answer did not send it. */
function headerCount(headers: Headers, name: string): number | null {
  const text = headers.get(name)?.trim() ?? "";
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** The window the rate-limit headers report. */
function fromHeaders(answer: BudgetAnswer, headers: Headers): void {
  const resource = headers.get("x-ratelimit-resource");
  const reset = headerCount(headers, "x-ratelimit-reset");
  if (resource === null || reset === null) return;
  const w = windowOf(
    headerCount(headers, "x-ratelimit-limit"),
    headerCount(headers, "x-ratelimit-remaining"),
    reset * 1000,
  );
  if (w !== null) place(answer, resource.trim().toLowerCase(), w);
}

function parsed(body: string): unknown {
  const text = body.trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    swallow(error, "an answer that is not JSON says nothing of the limits");
    return null;
  }
}

/** The GraphQL balance an answer selecting `rateLimit { remaining resetAt limit }` reports. */
function fromGraphQL(answer: BudgetAnswer, value: unknown): void {
  const data = isRecord(value) && isRecord(value.data) ? value.data : null;
  const rate =
    data !== null && isRecord(data.rateLimit) ? data.rateLimit : null;
  if (rate === null || typeof rate.resetAt !== "string") return;
  const reset = parseMs(rate.resetAt);
  const w = windowOf(
    rate.limit,
    rate.remaining,
    Number.isFinite(reset) ? reset : null,
  );
  if (w !== null && answer.complexity === undefined) answer.complexity = w;
}

/** Every limit the `rate_limit` endpoint reports. */
function fromRateLimit(answer: BudgetAnswer, value: unknown): void {
  const resources =
    isRecord(value) && isRecord(value.resources) ? value.resources : null;
  if (resources === null) return;
  for (const [resource, r] of Object.entries(resources)) {
    if (!isRecord(r) || typeof r.reset !== "number") continue;
    const w = windowOf(r.limit, r.remaining, r.reset * 1000);
    if (w !== null) place(answer, resource, w);
  }
}

/** When a refusal with `headers` clears: its `retry-after`, else the reset of the window it spent; `null` when they name neither. */
function namedWait(headers: Headers | null, now: number): number | null {
  if (headers === null) return null;
  const wait = retryAfterMs(headers, () => now);
  if (wait !== null) return now + wait;
  const reset = Number(headers.get("x-ratelimit-reset") ?? "");
  return headers.get("x-ratelimit-remaining") === "0" &&
    Number.isFinite(reset) &&
    reset * 1000 > now
    ? reset * 1000
    : null;
}

/**
 * What a refusal holds. A primary limit the headers name as spent holds
 * that window alone, which its headers already recorded at zero until its
 * reset; a secondary limit, or a refusal that shows no headers, holds the
 * credential.
 */
function refusal(
  answer: BudgetAnswer,
  headers: Headers | null,
  failure: OutboundFailure,
  now: number,
  secondary: boolean,
): void {
  answer.why = `GitHub refused the credential: ${failure.reason}`;
  const resource = headers?.get("x-ratelimit-resource")?.trim().toLowerCase();
  const unwaited =
    headers === null || retryAfterMs(headers, () => now) === null;
  // A primary limit the profile keeps a window for is held by that window.
  // A secondary refusal can carry the same zero balance, and holds the
  // credential whatever the headers say of one resource.
  if (
    !secondary &&
    unwaited &&
    namedWait(headers, now) !== null &&
    resource !== undefined &&
    resource in GITHUB_PROFILE.limits
  )
    return;
  const until = secondary && unwaited ? null : namedWait(headers, now);
  if (until !== null) answer.limitedUntil = until;
  else answer.unnamedRefusal = { ...GITHUB_PROFILE.secondary };
}

/** A refusal's text that names GitHub's secondary limit. */
const SECONDARY = /secondary rate|abuse detection/i;

/** What one run's answer says of the credential's limits. */
export function forgeAnswerOf(
  args: readonly string[],
  headers: Headers | null,
  body: string,
  failure: OutboundFailure | null,
  now: number,
  refusedText = "",
): BudgetAnswer {
  const answer: BudgetAnswer = {};
  if (headers !== null) fromHeaders(answer, headers);
  const value = parsed(body);
  if (args[0] === "api" && apiRoute(args) === "rate_limit") {
    fromRateLimit(answer, value);
    answer.snapshot = true;
  } else fromGraphQL(answer, value);
  if (failure?.code === "rate-limited")
    refusal(
      answer,
      headers,
      failure,
      now,
      SECONDARY.test(`${refusedText}\n${body}`),
    );
  return answer;
}

/** How one governed run goes: what it is admitted against, the command line it runs, and how its answer is read. */
export interface GhGovernance {
  /** Existing quota identity, also used for cross-process send pacing. */
  owner: string;
  /** The failure to answer at once instead of running, or `null` with the time it was admitted. */
  admit(): { refused: OutboundFailure } | { sentAt: number };
  /** The command line to run. */
  argv: string[];
  /** Record what the run's answer said, and give the caller the answer without the headers it did not ask for. */
  observe<T extends GhRun & { stdout?: string }>(
    result: T,
    sentAt: number,
    tookMs: number,
  ): T;
}

let governors = new Map<string, BudgetGovernor>();
let override: BudgetGovernor | null = null;

/** Govern the forge's runs with `governor` instead of the machine's record; `null` restores the machine's. For tests. */
export function setForgeGovernor(governor: BudgetGovernor | null): void {
  override = governor;
}

function governor(): BudgetGovernor {
  if (override !== null) return override;
  const path = defaultLedgerPath();
  let found = governors.get(path);
  if (found === undefined) {
    found = budgetGovernor(sqliteBudgetStore(path));
    governors = new Map([[path, found]]);
  }
  return found;
}

/** Whether the forge's runs are governed in this environment. */
function forgeBudgetOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    override !== null || env.JIG_FORGE_BUDGET?.trim().toLowerCase() !== "off"
  );
}

/**
 * The governance of one run of `gh` with `args`; `null` for a run that sends
 * nothing to GitHub, or while the budget is off. `captured` says the run's
 * output is captured whole, so headers added to it can be taken off.
 */
export function ghGovernance(
  args: readonly string[],
  opts: { env?: Record<string, string | undefined>; captured: boolean },
): GhGovernance | null {
  const limits = limitsOf(args);
  if (limits === null || !forgeBudgetOn(opts.env ?? process.env)) return null;
  const key = githubCredential(opts.env ?? process.env);
  const gov = governor();
  const { argv, strip } = withHeaders(args, opts.captured);
  const admitted = admission(
    limits,
    args,
    strip || (opts.captured && askedHeaders(args)),
  );
  // The window the admission actually reserved in: none when the record or
  // the balance was not known, whatever the admission asked for.
  let reservedIn: string | null = admitted.reserve ?? null;
  return {
    owner: key,
    argv,
    admit() {
      try {
        return {
          sentAt: gov.admit("GitHub", key, {
            ...admitted,
            // `trace.ts` retries contention within the call's deadline.
            nonblocking: true,
            onReserved: (name) => {
              reservedIn = name;
            },
          }),
        };
      } catch (error) {
        if (!isRateLimited(error)) throw error;
        return {
          refused: outboundFailure(
            "rate-limited",
            `${error.message}; nothing was sent`,
            { until: error.resetAt },
          ),
        };
      }
    },
    observe(result, sentAt, tookMs) {
      if (result.held !== undefined || result.spawnFailed === true) {
        // Nothing was sent: the request it reserved goes back.
        if (reservedIn !== null) gov.release?.(key, reservedIn, sentAt);
        return result;
      }
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const { headers, body } = splitHeaders(stdout);
      const status =
        opts.captured && (strip || askedHeaders(args))
          ? ghResponseStatus(result)
          : null;
      const observed =
        status === null ? result : { ...result, httpStatus: status };
      // A store that cannot take the answer governs nothing (`budget.ts`);
      // anything else that throws here is a defect, and stops the call.
      const failure = ghRunFailure(observed, tookMs);
      const now = currentMs();
      gov.observe(
        key,
        forgeAnswerOf(args, headers, body, failure, now, result.stderr ?? ""),
        sentAt,
        reservedIn,
      );
      const answered =
        strip && headers !== null ? { ...observed, stdout: body } : observed;
      if (failure?.code !== "rate-limited") return answered;
      // The caller waits as long as the record now holds the credential, or
      // for the reset of the window the refusal spent; not the generic wait.
      const until = gov.heldUntil?.(key) ?? namedWait(headers, now);
      return until === null ? answered : { ...answered, limitedUntil: until };
    },
  };
}

/** GitHub's balances in the credential's record: core and GraphQL as their windows hold them now, with when the record was last read. */
export function githubBalances(
  env: Record<string, string | undefined> = process.env,
  read: (key: string) => BudgetRecord | null = (key) =>
    sqliteBudgetStore(defaultLedgerPath()).read(key),
): { core: BudgetWindow; graphql: BudgetWindow; observedAt: number } | null {
  const record = read(githubCredential(env));
  if (record === null) return null;
  return {
    core: record.requests,
    graphql: record.complexity,
    observedAt: record.observedAt,
  };
}
