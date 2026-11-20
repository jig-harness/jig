/**
 * GitHub's limits in the machine's budget record (`budget.ts`): the profile
 * that says which limits GitHub has and how it reports and refuses them, and
 * the governance every run of the `gh` command-line client goes through at
 * the forge client's wrapper (`shared/trace.ts`).
 *
 * Before a run, the wrapper admits it against the record of the credential's
 * quota owner (`github-owner.ts`: the user every personal token of that
 * user spends, the installation every token of it spends, or the host's
 * shared record for a credential whose owner is not established): while
 * GitHub refuses the credential (a primary or a secondary limit), or while
 * the dispatcher's share of the limit the run spends is used, the run is not
 * started and fails at once as `rate-limited`, naming when it clears and
 * whose allowance is spent (the GitHub account, the installation, or the
 * host's shared record). After a run, the wrapper records what its answer
 * said:
 *
 * - a `gh api` call is sent with `--include`, so its answer carries the
 *   rate-limit headers (`x-ratelimit-resource`, `-limit`, `-remaining`,
 *   `-reset`, and `retry-after` on a refusal); the headers are taken off
 *   the output before the caller reads it;
 * - a captured `gh api --paginate` read is sent a page at a time, each page
 *   a run of its own (`gh-paginate.ts`); one gh pages itself reserves
 *   `PAGINATED_RESERVE` requests before it starts and keeps them;
 * - a GraphQL answer that selects `rateLimit` says the GraphQL balance;
 * - the `rate_limit` endpoint, which costs nothing against the primary
 *   limits, says every limit's balance;
 * - a primary limit the headers name as spent holds that limit until its
 *   reset; a secondary limit, or a refusal that shows no headers, holds the
 *   credential for every process on the machine: until its `retry-after`,
 *   else for a minute, doubled for each refusal in a row, up to fifteen;
 * - a refusal whose text names the user whose allowance is spent ("rate
 *   limit exceeded for user ID N") is recorded in that user's record when
 *   the run was admitted against another, the run's reservation given back,
 *   and the owner's resolver is told so the mapping is asked again;
 * - the `rate_limit` endpoint's answer replaces the balances the record
 *   holds, and a request that was not sent or that GitHub does not charge
 *   (a conditional request) keeps no reservation.
 *
 * The other subcommands (`gh pr view`, `gh issue list`) show no headers:
 * each reserves a point of the GraphQL balance, the least a query costs, so
 * the share still moves toward its floor, and the balance they spend is read
 * from the `rate_limit` endpoint, which the tick asks at most once, and from
 * their refusals' text. A refusal's caller is told the wait the record holds.
 * What the `rate_limit` endpoint shows was spent beyond what the record had
 * counted goes to the cost ledger's unattributed row (`UNATTRIBUTED`), never
 * to an operation.
 *
 * A GraphQL request sent over HTTPS (`httpsGovernance`: the tracker adapter
 * and the reflection store with `JIG_GITHUB_GRAPHQL_URL` set) is admitted
 * against the record of the token it sends and recorded in it as a
 * `gh api graphql` run is, so a refusal either meets holds the other.
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
  type BudgetStore,
  type BudgetWindow,
  type Unexplained,
  budgetGovernor,
  credentialKey,
  isRateLimited,
  sqliteBudgetStore,
} from "./budget.ts";
import {
  githubCredential,
  githubHost,
  legacyGithubCredential,
  unverifiedOwner,
  userOwner,
} from "./github-credential.ts";
import {
  type GithubOwnerResolver,
  githubOwnerResolver,
  sqliteOwnerStore,
  unverifiedAccount,
} from "./github-owner.ts";
import { ghRunScope } from "./github-scope.ts";
import { errorMessages, refusedUser } from "./github-refusal.ts";
import { apiRoute } from "./gh-route.ts";

export { refusedUser } from "./github-refusal.ts";
import { swallow } from "../errors.ts";
import { definedFields } from "../defined-fields.ts";
import type { GithubBalances } from "./graph-poll-budget.ts";
import { isRecord } from "../guards.ts";
import {
  type OutboundFailure,
  outboundFailure,
  retryAfterMs,
} from "./failure.ts";
import { type GhRun, ghResponseStatus, ghRunFailure } from "./github.ts";
import { defaultLedgerPath, recordCall, UNATTRIBUTED } from "./ledger.ts";
import { currentMs, parseMs } from "../time.ts";

export { githubCredential } from "./github-credential.ts";
export { apiRoute, apiRouteAt } from "./gh-route.ts";

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
 * quota owner's record, and what its refusals look like. The quota owner is
 * the user or the installation the credential belongs to.
 */
const GITHUB_PROFILE = {
  system: "github",
  owner: "user or installation",
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

/** `env` as the call sees it: with the host its `gh api --hostname` names, as `GH_HOST`. */
export function ghHostIn(
  args: readonly string[],
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (args[0] !== "api") return env;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const host =
      arg === "--hostname"
        ? args[i + 1]
        : arg.startsWith("--hostname=")
          ? arg.slice(11)
          : undefined;
    if (host !== undefined && host.trim() !== "")
      return { ...env, GH_HOST: host.trim() };
  }
  return env;
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
      ? conditional(args) && readable && !args.includes("--paginate")
        ? null
        : only
      : limits.includes("graphql")
        ? "graphql"
        : null;
  if (spent === null) return { windows, reserve: null };
  const profile = GITHUB_PROFILE.limits[spent];
  return { windows, reserve: profile.window, rollMs: profile.periodMs };
}

/**
 * The requests (or points) a paged read gh pages itself reserves before it
 * starts: a read whose output is not captured whole, or whose form the
 * forge client cannot page itself (`gh-paginate.ts`). How many pages it
 * sent is not known, so it is charged this many, estimated.
 */
export const PAGINATED_RESERVE = 10;

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

/** What a governed run learnt for its ledger row: the record it was kept under, and the limit its answer's headers named. */
export interface GhAttribution {
  owner?: string;
  resource?: string;
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

interface Machine {
  governor: BudgetGovernor;
  store: BudgetStore;
  owners: GithubOwnerResolver;
}

let machines = new Map<string, Machine>();
let override: BudgetGovernor | null = null;
let overrideOwners: GithubOwnerResolver | null = null;
let overridePacing = true;

/** Whether the supplied test governor keeps the shared pacing transport. */
export function forgeGovernorPacingOn(): boolean {
  return override === null || overridePacing;
}

/**
 * Govern the forge's runs with `governor` instead of the machine's record;
 * `null` restores the machine's. `owners` finds each credential's quota
 * owner; left out, a credential's runs are kept under its own key, as a
 * test of one credential reads them. For tests.
 */
export function setForgeGovernor(
  governor: BudgetGovernor | null,
  owners: GithubOwnerResolver | null = null,
  pace: boolean = true,
): void {
  override = governor;
  overrideOwners = governor === null ? null : owners;
  overridePacing = pace;
}

/** The machine's governor, store and owners over the budget database this process writes. */
function machine(): Machine {
  const path = defaultLedgerPath();
  let found = machines.get(path);
  if (found === undefined) {
    const store = sqliteBudgetStore(path);
    const governor = budgetGovernor(store, { keepGraphqlPollFloor: true });
    found = {
      governor,
      store,
      owners: githubOwnerResolver({
        owners: sqliteOwnerStore(path),
        budget: store,
        governor,
      }),
    };
    machines = new Map([[path, found]]);
  }
  return found;
}

function governor(): BudgetGovernor {
  return override ?? machine().governor;
}

/** Whether the forge's runs are governed in this environment. */
export function forgeBudgetOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    override !== null || env.JIG_FORGE_BUDGET?.trim().toLowerCase() !== "off"
  );
}

/** A plain `gh api user`: the discovery's own request, which finds no owner first. */
function asksOwnIdentity(args: readonly string[]): boolean {
  if (args[0] !== "api" || apiRoute(args) !== "user") return false;
  const at = args.findIndex((a) => a === "-X" || a === "--method");
  return at < 0 || (args[at + 1] ?? "").toUpperCase() === "GET";
}

/** The record a run is admitted against, whose allowance it is, and how to say GitHub named another user's. */
export interface ForgeOwner {
  /** The key of the record. */
  owner: string;
  /** Whose allowance the record keeps, for a person (`OwnerResolution.account`); absent when no owner was resolved. */
  account?: string;
  /** Tell the owner's resolver that GitHub refused the run for user `userId`'s allowance. */
  misattributed?: (userId: number) => void;
}

/**
 * The record a run of `gh` with `args`, from the working directory `cwd`,
 * is admitted against: its credential's quota owner, found once and
 * remembered (`github-owner.ts`), for the client's stored login per
 * repository the run addresses (`github-scope.ts`); `undefined` for a run
 * that is not governed. A plain `gh api user` asks no owner first: it uses
 * the owner already known, else the host's unverified record.
 */
export async function forgeOwner(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  deadlineMs?: number,
  cwd?: string,
): Promise<ForgeOwner | undefined> {
  if (limitsOf(args) === null || !forgeBudgetOn(env)) return undefined;
  const owners = override === null ? machine().owners : overrideOwners;
  if (owners === null) return { owner: githubCredential(env) };
  const scope = ghRunScope(args, env, cwd);
  const misattributed = (userId: number) =>
    owners.misattributed(env, scope, userId);
  const found = asksOwnIdentity(args)
    ? owners.known(env, scope)
    : await owners.resolve(env, deadlineMs, scope, cwd);
  if (found === null) {
    const host = githubHost(env);
    return {
      owner: unverifiedOwner(host),
      account: unverifiedAccount(host),
      misattributed,
    };
  }
  return { owner: found.owner, account: found.account, misattributed };
}

/** Tell the ledger row which resource answered, and read the HTTP status off a captured answer. */
function withObservedStatus<T extends GhRun>(
  result: T,
  headers: Headers | null,
  attribution: GhAttribution | undefined,
  readStatus: boolean,
): T {
  const resource = headers?.get("x-ratelimit-resource")?.trim();
  if (attribution !== undefined && resource)
    attribution.resource = resource.toLowerCase();
  const status = readStatus ? ghResponseStatus(result) : null;
  return status === null ? result : ({ ...result, httpStatus: status } as T);
}

/** One request admitted against the credential's record and observed into it, whatever carries it. */
interface Governed {
  admit(): { refused: OutboundFailure } | { sentAt: number };
  /** Give back what the admission reserved: nothing was sent. */
  release(sentAt: number): void;
  /** Record what the answer said; for a refusal, when the caller may send again, else `null`. */
  observe(
    args: readonly string[],
    headers: Headers | null,
    body: string,
    failure: OutboundFailure | null,
    sentAt: number,
    refusedText?: string,
  ): number | null;
}

/** The unit of the cost ledger each record window counts in. */
const LEDGER_UNITS = { requests: "requests", complexity: "points" } as const;

/** The points a GraphQL answer's `rateLimit.cost` reports, `null` when it reports none. */
function measuredCost(body: string): number | null {
  const value = parsed(body);
  const data = isRecord(value) && isRecord(value.data) ? value.data : null;
  const rate =
    data !== null && isRecord(data.rateLimit) ? data.rateLimit : null;
  return rate !== null && typeof rate.cost === "number" && rate.cost >= 0
    ? rate.cost
    : null;
}

/** The points an answer measured beyond its reservation, when it reported a cost but no balance. */
function measuredBeyondReservation(
  body: string,
  answer: BudgetAnswer,
  reserved: number,
): number {
  if (answer.complexity !== undefined) return 0;
  const cost = measuredCost(body);
  return cost === null || cost <= reserved ? 0 : cost - reserved;
}

/** Put what a snapshot showed was spent beyond the record's count on the cost ledger's unattributed row. */
function recordUnexplained(
  key: string,
  unexplained: Unexplained | undefined,
  snapshot: boolean,
): void {
  if (unexplained === undefined || !snapshot) return;
  for (const [name, unit] of Object.entries(LEDGER_UNITS)) {
    const shown = unexplained[name as keyof Unexplained];
    const cost = shown;
    if (cost === undefined || cost <= 0) continue;
    recordCall({
      system: "github",
      credential: key,
      owner: key,
      window: name,
      operation: UNATTRIBUTED,
      caller: UNATTRIBUTED,
      requests: 0,
      cost,
      unit,
      estimated: false,
      durationMs: 0,
    });
  }
}

/** Whose allowance a governed request's record keeps, and where a refusal naming another user goes. */
interface Whose {
  /** Said in a refusal: whose allowance the record keeps. */
  allowance?: string;
  /** The host a user named by a refusal is on. */
  host: string;
  /** Told the user a refusal named, when the record was another's; the answer was recorded under `owner`. Without it, a refusal is recorded where the run was admitted. */
  misattributed?(userId: number, owner: string): void;
}

/** The user a rate-limit refusal says it spent the allowance of, when that is not `key`'s record and `whose` can be told. */
function otherUser(
  whose: Whose | undefined,
  key: string,
  failure: OutboundFailure | null,
  text: string,
): { userId: number; owner: string } | null {
  if (failure?.code !== "rate-limited" || whose?.misattributed === undefined)
    return null;
  const userId = refusedUser(text);
  if (userId === null) return null;
  const owner = userOwner(whose.host, userId);
  return owner === key ? null : { userId, owner };
}

/**
 * How a run's refusal names whose allowance it is kept to, and where a
 * refusal GitHub says spent another user's allowance goes: `owner`'s
 * resolver is told, and the ledger row names that user's record.
 */
function whoseOf(
  owner: ForgeOwner | undefined,
  host: string,
  attribution: GhAttribution | undefined,
): Whose | undefined {
  const account = owner?.account;
  const told = owner?.misattributed;
  if (account === undefined && told === undefined) return undefined;
  const whose: Whose = { host };
  if (account !== undefined)
    whose.allowance =
      account === unverifiedAccount(host)
        ? account
        : `the allowance of ${account}`;
  if (told !== undefined)
    whose.misattributed = (userId, other) => {
      if (attribution !== undefined) attribution.owner = other;
      told(userId);
    };
  return whose;
}

/**
 * A request for the credential `key`, admitted with `admitted`. A read gh
 * pages itself sends an unknown number of requests: it reserves `reservations`
 * of them, each admitted above the floor, and keeps them once it ran.
 * With `whose`, a refusal says whose allowance is spent, and a refusal GitHub
 * says was for another user's allowance is recorded in that user's record,
 * the reservation given back to `key`'s.
 */
function governed(
  key: string,
  admitted: AdmitOptions,
  reservations = 1,
  whose?: Whose,
): Governed {
  const gov = governor();
  // The window the admission actually reserved in: none when the record or
  // the balance was not known, whatever the admission asked for.
  let reservedIn: string | null = admitted.reserve ?? null;
  const taken: number[] = [];
  const giveBack = () => {
    for (const at of taken.splice(0))
      if (reservedIn !== null) gov.release?.(key, reservedIn, at);
  };
  const said = whose?.allowance === undefined ? "" : ` (${whose.allowance})`;
  return {
    admit() {
      try {
        const at = gov.admit("GitHub", key, {
          ...admitted,
          count: reservations,
          // The caller retries contention within the call's deadline.
          nonblocking: true,
          onReserved: (name) => {
            reservedIn = name;
          },
        });
        taken.push(...Array.from({ length: reservations }, () => at));
        return { sentAt: at };
      } catch (error) {
        if (!isRateLimited(error)) throw error;
        giveBack();
        return {
          refused: outboundFailure(
            "rate-limited",
            `${error.message}${said}; nothing was sent`,
            {
              until: error.resetAt,
              account: key,
              quota: { system: error.adapter, share: error.share === true },
            },
          ),
        };
      }
    },
    release(sentAt) {
      // Nothing was sent: the requests it reserved go back.
      if (taken.length === 0) taken.push(sentAt);
      giveBack();
    },
    observe(args, headers, body, failure, sentAt, refusedText = "") {
      const now = currentMs();
      // A store that cannot take the answer governs nothing (`budget.ts`);
      // anything else that throws here is a defect, and stops the call.
      const answer = forgeAnswerOf(
        args,
        headers,
        body,
        failure,
        now,
        refusedText,
      );
      const other = otherUser(
        whose,
        key,
        failure,
        `${refusedText}\n${errorMessages(body)}`,
      );
      if (other !== null) {
        // The answer spent the named user's allowance: it holds that
        // user's record, and the reservation goes back to the record the
        // run was admitted against.
        giveBack();
        gov.observe(other.owner, answer, sentAt, null);
        whose?.misattributed?.(other.userId, other.owner);
        return gov.heldUntil?.(other.owner) ?? namedWait(headers, now);
      }
      const extra = measuredBeyondReservation(
        body,
        answer,
        reservedIn === "complexity" ? reservations : 0,
      );
      if (extra > 0) answer.extraComplexity = extra;
      recordUnexplained(
        key,
        gov.observe(key, answer, sentAt, reservedIn),
        answer.snapshot === true,
      );
      if (failure?.code !== "rate-limited") return null;
      // The caller waits as long as the record now holds the credential, or
      // for the reset of the window the refusal spent; not the generic wait.
      return gov.heldUntil?.(key) ?? namedWait(headers, now);
    },
  };
}

/**
 * The governance of one run of `gh` with `args`; `null` for a run that sends
 * nothing to GitHub, or while the budget is off. `captured` says the run's
 * output is captured whole, so headers added to it can be taken off. `owner`
 * is the record the run is admitted against (`forgeOwner`), the credential's
 * own key when left out; with its `account`, a refusal names whose allowance
 * is spent, and with its `misattributed`, a refusal GitHub says was for
 * another user's allowance holds that user's record and is told to the
 * owner's resolver. `attribution` is told what the ledger row needs.
 */
export function ghGovernance(
  args: readonly string[],
  opts: {
    env?: Record<string, string | undefined>;
    captured: boolean;
    owner?: string | ForgeOwner;
    attribution?: GhAttribution;
  },
): GhGovernance | null {
  const env = opts.env ?? process.env;
  const limits = limitsOf(args);
  if (limits === null || !forgeBudgetOn(env)) return null;
  const owner: ForgeOwner | undefined =
    typeof opts.owner === "string" ? { owner: opts.owner } : opts.owner;
  const key = owner?.owner ?? githubCredential(env);
  if (opts.attribution !== undefined) opts.attribution.owner = key;
  const { argv, strip } = withHeaders(args, opts.captured);
  const request = governed(
    key,
    admission(limits, args, strip || (opts.captured && askedHeaders(args))),
    args.includes("--paginate") ? PAGINATED_RESERVE : 1,
    whoseOf(owner, githubHost(env), opts.attribution),
  );
  return {
    owner: key,
    argv,
    admit: () => request.admit(),
    observe(result, sentAt, tookMs) {
      if (result.held !== undefined || result.spawnFailed === true) {
        request.release(sentAt);
        return result;
      }
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const { headers, body } = splitHeaders(stdout);
      const observed = withObservedStatus(
        result,
        headers,
        opts.attribution,
        opts.captured && (strip || askedHeaders(args)),
      );
      const failure = ghRunFailure(observed, tookMs);
      const until = request.observe(
        args,
        headers,
        body,
        failure,
        sentAt,
        result.stderr ?? "",
      );
      const answered =
        strip && headers !== null ? { ...observed, stdout: body } : observed;
      if (failure === null) return answered;
      return {
        ...answered,
        failureAccount: opts.attribution?.owner ?? key,
        ...(until === null ? {} : { limitedUntil: until }),
      };
    },
  };
}

/** How one GraphQL request sent over HTTPS goes: what it is admitted against, and how its answer is recorded. */
export interface HttpsGovernance {
  /** Existing quota identity, also used for cross-process send pacing. */
  owner: string;
  /** The failure to answer at once instead of sending, or the time it was admitted. */
  admit(): { refused: OutboundFailure } | { sentAt: number };
  /** Give back the reservation of a request that was not sent. */
  release(sentAt: number): void;
  /**
   * Record what the answer said: its headers, its body and the failure it
   * met. For a rate-limited answer, when the caller may send again as the
   * record now holds it; else `null`.
   */
  observe(
    headers: Headers | null,
    body: string,
    failure: OutboundFailure | null,
    sentAt: number,
  ): number | null;
}

/** The command line a GraphQL request over HTTPS stands for, as the profile reads it. */
const HTTPS_GRAPHQL = ["api", "graphql"] as const;

/**
 * The governance of one GraphQL request sent over HTTPS with `token`, under
 * the record a `gh` run signed in with the same token keeps; `null` while
 * the budget is off. It reserves a point of the GraphQL balance, as a run
 * whose answer may not report its cost does.
 */
export function httpsGovernance(
  token: string,
  env: Record<string, string | undefined> = process.env,
): HttpsGovernance | null {
  if (!forgeBudgetOn(env)) return null;
  const key = credentialKey("github", token);
  const request = governed(key, admission(["graphql"], HTTPS_GRAPHQL, true));
  return {
    owner: key,
    admit: () => request.admit(),
    release: (sentAt) => request.release(sentAt),
    observe: (headers, body, failure, sentAt) =>
      request.observe(HTTPS_GRAPHQL, headers, body, failure, sentAt),
  };
}

/** Read the local balance under the same repository scope as a default `gh` call. */
export function githubBalances(
  env: Record<string, string | undefined> = process.env,
  read: (key: string) => BudgetRecord | null = (key) =>
    machine().store.read(key),
  owner: (env: Record<string, string | undefined>) => string | null = (e) =>
    (
      machine().owners.known(
        e,
        ghRunScope(["api", "rate_limit"], e, process.cwd()),
      ) ?? machine().owners.known(e)
    )?.owner ?? null,
): GithubBalances | null {
  for (const credential of [
    owner(env),
    githubCredential(env),
    legacyGithubCredential(env),
  ]) {
    const record = credential === null ? null : read(credential);
    if (credential !== null && record !== null)
      return {
        core: record.requests,
        graphql: record.complexity,
        observedAt: record.observedAt,
        credential,
        ...definedFields({ windows: record.windows }),
      };
  }
  return null;
}
