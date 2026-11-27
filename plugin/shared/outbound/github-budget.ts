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
  type BudgetGovernor,
  type BudgetRecord,
  type BudgetStore,
  type Unexplained,
  budgetGovernor,
  credentialKey,
  sqliteBudgetStore,
} from "./budget.ts";
import {
  githubCredential,
  githubHost,
  installationToken,
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
import { apiRoute } from "./gh-route.ts";
import { definedFields } from "../defined-fields.ts";
import type { GithubBalances } from "./graph-poll-budget.ts";
import {
  admission,
  type Governed,
  governedRequest,
  limitsOf,
  PAGINATED_RESERVE,
  splitHeaders,
  type Whose,
} from "./github-answer.ts";
import {
  outboundFailure,
  type FailureClass,
  type OutboundFailure,
} from "./failure.ts";
import { ok, type Outcome } from "../outcome.ts";
import { type GhRun, ghResponseStatus, ghRunFailure } from "./github.ts";
import { defaultLedgerPath, recordCall, UNATTRIBUTED } from "./ledger.ts";

export { refusedUser } from "./github-refusal.ts";
export { githubCredential } from "./github-credential.ts";
export { apiRoute, apiRouteAt } from "./gh-route.ts";
export {
  conditional,
  forgeAnswerOf,
  GITHUB_WINDOW_NAMES,
  limitsOf,
  PAGINATED_RESERVE,
  splitHeaders,
} from "./github-answer.ts";

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

let singleIdentityLookup = false;

/** Reuse a drive's authenticated-user lookup for its process lifetime. */
export function reuseForgeIdentity(): void {
  singleIdentityLookup = true;
}

export function forgeIdentityReused(): boolean {
  return singleIdentityLookup;
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
        singleLookup: () => singleIdentityLookup,
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

/** Resolve the login through quota-owner discovery. Undefined means discovery does not apply. */
export async function forgeLogin(
  deadlineMs?: number,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Promise<Outcome<string, FailureClass> | undefined> {
  if (!forgeBudgetOn(env) || installationToken(env)) return undefined;
  const owners = override === null ? machine().owners : overrideOwners;
  if (owners === null) return undefined;
  const scope = ghRunScope(["api", "user"], env, cwd);
  const found = await owners.resolve(env, deadlineMs, scope, cwd);
  return found.login === null
    ? {
        ok: false,
        failure:
          found.discoveryFailure ??
          outboundFailure("unreachable", "the forge client names no login"),
      }
    : ok(found.login);
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

/** The unit of the cost ledger each record window counts in. */
const LEDGER_UNITS = { requests: "requests", complexity: "points" } as const;

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

/** A request for `key` admitted against this process's governor, a snapshot's unexplained spending put on the ledger's unattributed row. */
function governed(
  key: string,
  admitted: AdmitOptions,
  reservations = 1,
  whose?: Whose,
): Governed {
  return governedRequest(
    governor(),
    key,
    admitted,
    reservations,
    whose,
    recordUnexplained,
  );
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
  const whose: Whose = { ownerOf: (userId) => userOwner(host, userId) };
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
