/**
 * What GitHub's answers say of its limits, read the same way whatever
 * carried the request (a run of the `gh` command-line client or a `fetch`
 * request): which limits a request spends and what it is admitted against
 * (`GITHUB_PROFILE`), the rate-limit headers, a GraphQL answer's
 * `rateLimit`, the `rate_limit` endpoint's snapshot, and what a refusal
 * holds. `governedRequest` admits one request against a quota owner's
 * record and observes its answer into it, through any `BudgetGovernor`.
 * Nothing here keeps state of its own or reads the machine: the governor's
 * store keeps the records (`github-budget.ts` for the machine's).
 */
import { dropped } from "../dropped.ts";
import { isRecord } from "../guards.ts";
import { currentMs, parseMs } from "../time.ts";
import {
  type AdmitOptions,
  type BudgetAnswer,
  type BudgetGovernor,
  type BudgetWindow,
  isRateLimited,
  type Unexplained,
} from "./budget-governor.ts";
import {
  type OutboundFailure,
  outboundFailure,
  retryAfterMs,
} from "./failure.ts";
import { apiRoute } from "./gh-route.ts";
import { linkNext } from "./paging.ts";
import { errorMessages, refusedUser } from "./github-refusal.ts";

/** Told what a snapshot answer showed was spent beyond what the record of `key` had counted. */
export type SpendingUnexplained = (
  key: string,
  unexplained: Unexplained | undefined,
  snapshot: boolean,
) => void;

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
export function admission(
  limits: readonly GitHubLimit[],
  args: readonly string[],
  readable: boolean,
): AdmitOptions {
  return admissionOf(limits, {
    conditional: conditional(args) && !args.includes("--paginate"),
    readable,
  });
}

/**
 * `admission` for a request described rather than written as a command
 * line: whether it is a conditional request of a single page, and whether
 * its answer's headers are read.
 */
export function admissionOf(
  limits: readonly GitHubLimit[],
  request: { conditional: boolean; readable: boolean },
): AdmitOptions {
  const windows = limits.map((l) => GITHUB_PROFILE.limits[l].window);
  const only = limits.length === 1 ? limits[0] : undefined;
  const spent: GitHubLimit | null =
    only !== undefined && GITHUB_PROFILE.limits[only].unit === "requests"
      ? request.conditional && request.readable
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
      dropped(
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
    dropped(error, "an answer that is not JSON says nothing of the limits");
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

/** One request admitted against the credential's record and observed into it, whatever carries it. */
export interface Governed {
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

/** The points a GraphQL answer's `rateLimit.cost` reports, `null` when it reports none. */
export function measuredCost(body: string): number | null {
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

/** Whose allowance a governed request's record keeps, and where a refusal naming another user goes. */
export interface Whose {
  /** Said in a refusal: whose allowance the record keeps. */
  allowance?: string;
  /** The record of the user a refusal names, on the host the request was sent to. */
  ownerOf(userId: number): string;
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
  const owner = whose.ownerOf(userId);
  return owner === key ? null : { userId, owner };
}

/**
 * A request for the credential `key`, admitted with `admitted` by `gov`. A read gh
 * pages itself sends an unknown number of requests: it reserves `reservations`
 * of them, each admitted above the floor, and keeps them once it ran.
 * With `whose`, a refusal says whose allowance is spent, and a refusal GitHub
 * says was for another user's allowance is recorded in that user's record,
 * the reservation given back to `key`'s. `unexplained` is told what a
 * snapshot answer showed was spent beyond what the record had counted.
 */
export function governedRequest(
  gov: BudgetGovernor,
  key: string,
  admitted: AdmitOptions,
  reservations = 1,
  whose?: Whose,
  unexplained?: SpendingUnexplained,
): Governed {
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
      const shown = gov.observe(key, answer, sentAt, reservedIn);
      unexplained?.(key, shown, answer.snapshot === true);
      if (failure?.code !== "rate-limited") return null;
      // The caller waits as long as the record now holds the credential, or
      // for the reset of the window the refusal spent; not the generic wait.
      return gov.heldUntil?.(key) ?? namedWait(headers, now);
    },
  };
}

/** Whether `url` is an https URL on the API origin of `host` (`api.<host>`, or `<host>` itself for an enterprise server). */
export function onApiOrigin(url: string, host: string): boolean {
  try {
    const at = new URL(url);
    return (
      at.protocol === "https:" &&
      at.username === "" &&
      at.password === "" &&
      (at.hostname === host || at.hostname === `api.${host}`)
    );
  } catch (error) {
    dropped(error, "a next link that is not a URL is not followed");
    return false;
  }
}

/** The URL the `Link` header names as the next page, when it is on `host`'s API origin. */
export function nextLink(headers: Headers | null, host: string): string | null {
  const url = linkNext(headers);
  return url !== null && onApiOrigin(url, host) ? url : null;
}
