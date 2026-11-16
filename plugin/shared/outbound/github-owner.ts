/**
 * Whose allowance a GitHub credential spends: the quota owner whose record
 * (`budget.ts`) admission and observation use, kept apart from the
 * credential itself (`github-credential.ts`).
 *
 * - **A user's credential** (a personal token, or the client's stored
 *   login) is asked once who it is: `gh api user`, run directly with a
 *   10-second deadline and no governance of its own, so it cannot recurse
 *   into the owner it is finding. Its answer's numeric `id` names the owner
 *   (`user:<id>` on the host). The mapping from the credential's key and
 *   host to the owner's is kept in the budget database (table
 *   `github_owner`) for every
 *   process: a week for a token, whose user never changes, a day for a
 *   stored login. The request is admitted against the unverified record and
 *   counted in the ledger as `GET /user`.
 * - **An installation token** (`ghs_`) cannot name its installation: GitHub
 *   answers no request for it with the installation's id. Its owner is the
 *   installation the token's issuer declares beside it
 *   (`JIG_GITHUB_INSTALLATION_ID`, a positive integer), on the host the
 *   token is used on. Two tokens of one installation, a replacement after
 *   expiry included, keep one record and its hold.
 *
 * **When the owner cannot be established** (the discovery failed or is
 * waiting to try again, an installation token with no declaration, an
 * answer that does not read), the credential is kept under one record per
 * host that every such credential shares (`unverified`). It can only make
 * those credentials spend less than their allowances together, never more,
 * and a hold seen there holds every unverified credential on the host. A
 * failed discovery is tried again after 15 minutes, never on each call; an
 * owner verified before keeps being used while its check is retried.
 *
 * **Records an earlier release kept** under the credential's own key stay
 * as they are, readable by that release. The first time an owner's record
 * is used and does not exist yet, it is seeded from the credential's
 * earlier record (the stored login's earlier key had no account in it);
 * when it exists, the earlier record is merged into it, once a process.
 * Merging is conservative and never drops an active hold: the later hold,
 * the higher count of refusals in a row, and for each window the lower
 * balance when both name one reset, else the one with the later reset.
 */
import type { Database } from "bun:sqlite";
import {
  type BudgetGovernor,
  type BudgetRecord,
  type BudgetStore,
  type BudgetWindow,
  isRateLimited,
} from "./budget.ts";
import { recordCall } from "./ledger.ts";
import { swallow } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { type OutboundFailure, outboundFailure } from "./failure.ts";
import { type GhRun, ghRunFailure } from "./github.ts";
import {
  declaredInstallation,
  githubCredential,
  githubHost,
  githubToken,
  installationOwner,
  installationToken,
  legacyGithubCredential,
  unverifiedOwner,
  userOwner,
} from "./github-credential.ts";
import { inTransaction, openDatabase } from "../records/db.ts";
import { BUDGET_MIGRATIONS } from "./schema.ts";
import { currentMs } from "../time.ts";

type Env = Record<string, string | undefined>;

/** How long the owner a token named is trusted before it is asked again. */
const TOKEN_OWNER_TTL_MS = 7 * 24 * 3_600_000;
/** How long the owner a stored login named is trusted before it is asked again. */
const LOGIN_OWNER_TTL_MS = 24 * 3_600_000;
/** How long a mapping nobody asked again is kept. */
const OWNER_RETENTION_MS = 30 * 24 * 3_600_000;
/** How long a failed discovery waits before it is tried again. */
export const DISCOVERY_BACKOFF_MS = 15 * 60_000;
/** The discovery request's deadline. */
const DISCOVERY_DEADLINE_MS = 10_000;

/** What the machine knows of one credential's owner. */
export interface OwnerEntry {
  /** The owner's record key; the host's unverified record when it was not established. */
  owner: string;
  verified: boolean;
  /** The login the discovery answered with; `null` when none did. */
  login: string | null;
  checkedAt: number;
  /** When to ask again. */
  retryAt: number;
}

/** Where the owners are kept, by the credential's key and the host it is used on. */
export interface OwnerStore {
  read(credential: string, host: string): OwnerEntry | null;
  write(credential: string, host: string, entry: OwnerEntry): void;
}

interface OwnerRow {
  owner: string;
  verified: number;
  login: string | null;
  checked_at: number;
  retry_at: number;
}

/** The owners in the budget database at `path`; one that cannot be opened keeps nothing. */
export function sqliteOwnerStore(
  path: string,
  clock: () => number = currentMs,
): OwnerStore {
  let db: Database | null | undefined;
  const open = (): Database | null => {
    if (db !== undefined) return db;
    const opened = openDatabase({ path, migrations: BUDGET_MIGRATIONS });
    if (!opened.ok) swallow(opened.failure, "the GitHub owner store");
    db = opened.ok ? opened.value : null;
    // A credential nobody has used since its check came due is forgotten.
    try {
      db?.query("DELETE FROM github_owner WHERE retry_at < ?").run(
        clock() - OWNER_RETENTION_MS,
      );
    } catch (error) {
      swallow(error, "prune the GitHub owner store");
    }
    return db;
  };
  return {
    read(credential, host) {
      try {
        const row = open()
          ?.query(
            "SELECT owner, verified, login, checked_at, retry_at FROM github_owner WHERE credential = ? AND host = ?",
          )
          .get(credential, host) as OwnerRow | null | undefined;
        if (row == null || typeof row.owner !== "string") return null;
        return {
          owner: row.owner,
          verified: row.verified === 1,
          login: row.login,
          checkedAt: row.checked_at,
          retryAt: row.retry_at,
        };
      } catch (error) {
        swallow(error, "read the GitHub owner store");
        return null;
      }
    },
    write(credential, host, entry) {
      try {
        const d = open();
        if (d === null) return;
        inTransaction(d, () => {
          d.query(
            "INSERT OR REPLACE INTO github_owner (credential, host, owner, verified, login, checked_at, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            credential,
            host,
            entry.owner,
            entry.verified ? 1 : 0,
            entry.login,
            entry.checkedAt,
            entry.retryAt,
          );
        });
      } catch (error) {
        swallow(error, "write the GitHub owner store");
      }
    },
  };
}

/** Who a user's credential is, as `GET /user` answers. */
export interface GithubUser {
  id: number;
  login: string;
}

/** Ask who the credential `env` names is, within `deadlineMs`. */
export type DiscoverUser = (
  env: Env,
  deadlineMs: number,
) => Promise<{ user: GithubUser } | { failure: OutboundFailure }>;

/** The user an answer to `GET /user` names; `null` when it names none. */
export function userOf(body: string): GithubUser | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) return null;
    const { id, login } = value;
    return typeof id === "number" &&
      Number.isSafeInteger(id) &&
      id > 0 &&
      typeof login === "string" &&
      /^[A-Za-z0-9-]+(\[bot\])?$/.test(login)
      ? { id, login }
      : null;
  } catch (error) {
    swallow(error, "an answer to GET /user that is not JSON names no user");
    return null;
  }
}

/** Runs `gh` with `args` as the forge client does: bounded, admitted and recorded. */
export type GhRunner = (
  args: string[],
  env: Env,
  timeoutSec: number,
) => Promise<GhRun & { stdout?: unknown }>;

let runner: GhRunner | null = null;

/** The forge client's traced runner, which the default discovery goes through; the first one registered is kept. */
export function setDiscoveryRunner(run: GhRunner): void {
  runner ??= run;
}

/**
 * `gh api user` through the forge client's wrapper, which bounds it as every
 * run is (the process tree is ended at the deadline) and admits and records
 * it; a plain `gh api user` is governed against the owner already known, or
 * the host's unverified record, never against the owner it is finding.
 */
const ghUser: DiscoverUser = async (env, deadlineMs) => {
  if (runner === null)
    return {
      failure: outboundFailure("unauthorized", "no gh runner to ask with"),
    };
  const began = currentMs();
  const result = await runner(
    ["api", "user"],
    env,
    Math.max(1, Math.ceil(deadlineMs / 1000)),
  );
  const failure = ghRunFailure(result, currentMs() - began);
  if (failure !== null) return { failure };
  const user = userOf(typeof result.stdout === "string" ? result.stdout : "");
  return user === null
    ? {
        failure: outboundFailure("invalid", "GET /user answered with no user"),
      }
    : { user };
};

/** Whose allowance a credential spends. */
export interface OwnerResolution {
  /** The credential's own key. */
  credential: string;
  /** The key of the record its runs are admitted against. */
  owner: string;
  /** Whether the owner was established; `false` for the host's unverified record. */
  verified: boolean;
  /** The login the discovery answered with, when one did. */
  login: string | null;
}

/** Finds and remembers credentials' owners. */
export interface GithubOwnerResolver {
  /** The owner, asking GitHub at most once a check period. */
  resolve(env: Env, deadlineMs?: number): Promise<OwnerResolution>;
  /** The owner the machine already knows, sending nothing; `null` for a credential never asked. */
  known(env: Env): OwnerResolution | null;
}

/** The ledger row of a discovery the wrapper did not record. */
function ledgerLookup(
  credential: string,
  owner: string,
  answer: { user: GithubUser } | { failure: OutboundFailure },
  durationMs: number,
): void {
  recordCall({
    system: "github",
    credential,
    owner,
    window: "requests",
    operation: "GET /user",
    requests: 1,
    cost: 1,
    estimated: true,
    unit: "requests",
    durationMs,
    failure: "failure" in answer ? answer.failure.code : null,
  });
}

/** A resolver over `owners` and the budget records in `budget`; `discover` and `clock` are for tests. */
export function githubOwnerResolver(deps: {
  owners: OwnerStore;
  budget: BudgetStore;
  governor?: BudgetGovernor;
  discover?: DiscoverUser;
  clock?: () => number;
}): GithubOwnerResolver {
  const clock = deps.clock ?? currentMs;
  const discover = deps.discover ?? ghUser;
  const memo = new Map<
    string,
    { resolution: OwnerResolution; until: number }
  >();
  const inflight = new Map<string, Promise<OwnerResolution>>();
  const seeded = new Set<string>();

  const unverified = (env: Env, credential: string): OwnerResolution => ({
    credential,
    owner: unverifiedOwner(githubHost(env)),
    verified: false,
    login: null,
  });

  /** An installation token's owner, which only its declaration names. */
  const installation = (env: Env, credential: string): OwnerResolution => {
    const id = declaredInstallation(env);
    return id === null
      ? unverified(env, credential)
      : {
          credential,
          owner: installationOwner(githubHost(env), id),
          verified: true,
          login: null,
        };
  };

  const fromEntry = (credential: string, e: OwnerEntry): OwnerResolution => ({
    credential,
    owner: e.owner,
    verified: e.verified,
    login: e.login,
  });

  /** Carry the credential's earlier record into its owner's, once a process. */
  const seed = (env: Env, owner: string): void => {
    const legacy = legacyGithubCredential(env);
    const pair = `${legacy}>${owner}`;
    if (legacy === owner || seeded.has(pair)) return;
    seeded.add(pair);
    const earlier = deps.budget.read(legacy);
    if (earlier === null) return;
    const now = clock();
    deps.budget.update(owner, (prev) => carried(prev, earlier, now));
  };

  const ask = async (
    env: Env,
    credential: string,
    entry: OwnerEntry | null,
    deadlineMs: number,
  ): Promise<OwnerResolution> => {
    const now = clock();
    const fallback = unverified(env, credential);
    // The request is admitted, observed and recorded as any run of `gh` is,
    // against the unverified record, the owner not being known yet.
    // While the unverified record is held nothing is sent.
    try {
      deps.governor?.admit("GitHub", fallback.owner, {
        windows: ["requests"],
        reserve: null,
      });
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      return entry?.verified === true ? fromEntry(credential, entry) : fallback;
    }
    const began = currentMs();
    const answer = await discover(env, deadlineMs);
    const user = "user" in answer ? answer.user : null;
    const owner =
      user !== null
        ? userOwner(githubHost(env), user.id)
        : entry?.verified === true
          ? entry.owner
          : fallback.owner;
    // The answer's own quota headers were observed against the unverified
    // record, the owner not being known then: apply them to the owner it
    // named, when that record was read during this discovery.
    if (user !== null && owner !== fallback.owner) {
      const seen = deps.budget.read(fallback.owner);
      if (seen !== null && seen.observedAt >= began)
        deps.budget.update(owner, (prev) =>
          withDiscoveryWindow(prev, seen, clock()),
        );
    }
    // The default discovery is a run of `gh` the wrapper records itself; a
    // discovery given in its place is recorded here.
    if (deps.discover !== undefined)
      ledgerLookup(credential, owner, answer, currentMs() - began);
    const next: OwnerEntry =
      user !== null
        ? {
            owner,
            verified: true,
            login: user.login,
            checkedAt: now,
            retryAt:
              now +
              (githubToken(env) === null
                ? LOGIN_OWNER_TTL_MS
                : TOKEN_OWNER_TTL_MS),
          }
        : {
            owner,
            verified: entry?.verified === true,
            login: entry?.login ?? null,
            checkedAt: now,
            retryAt: now + DISCOVERY_BACKOFF_MS,
          };
    deps.owners.write(credential, githubHost(env), next);
    return fromEntry(credential, next);
  };

  const known = (env: Env): OwnerResolution | null => {
    const credential = githubCredential(env);
    if (installationToken(env)) return installation(env, credential);
    const entry = deps.owners.read(credential, githubHost(env));
    return entry === null ? null : fromEntry(credential, entry);
  };

  const resolve = async (
    env: Env,
    deadlineMs: number = DISCOVERY_DEADLINE_MS,
  ): Promise<OwnerResolution> => {
    const credential = githubCredential(env);
    if (installationToken(env)) {
      const found = installation(env, credential);
      seed(env, found.owner);
      return found;
    }
    const now = clock();
    const host = githubHost(env);
    const slot = `${credential}@${host}`;
    const held = memo.get(slot);
    if (held !== undefined && held.until > now) return held.resolution;
    const pending = inflight.get(slot);
    if (pending !== undefined) return within(pending, env, deadlineMs);
    const entry = deps.owners.read(credential, host);
    if (entry !== null && entry.retryAt > now) {
      const found = fromEntry(credential, entry);
      memo.set(slot, { resolution: found, until: entry.retryAt });
      seed(env, found.owner);
      return found;
    }
    const asked = ask(
      env,
      credential,
      entry,
      Math.min(DISCOVERY_DEADLINE_MS, deadlineMs),
    )
      .then((found) => {
        // A refused admission stores nothing: the process waits out the
        // backoff before it asks again.
        const until = deps.owners.read(credential, host)?.retryAt ?? 0;
        memo.set(slot, {
          resolution: found,
          until: until > clock() ? until : clock() + DISCOVERY_BACKOFF_MS,
        });
        seed(env, found.owner);
        return found;
      })
      .finally(() => inflight.delete(slot));
    inflight.set(slot, asked);
    return asked;
  };

  /** A caller's wait on a shared discovery, bounded by its own deadline; the discovery goes on for the others. */
  const within = (
    pending: Promise<OwnerResolution>,
    env: Env,
    deadlineMs: number,
  ): Promise<OwnerResolution> => {
    const bound = Math.min(DISCOVERY_DEADLINE_MS, deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<OwnerResolution>((resolve) => {
      timer = setTimeout(
        () => resolve(unverified(env, githubCredential(env))),
        Math.max(0, bound),
      );
    });
    return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
  };

  return { resolve, known };
}

/** Whether a window holds a balance that has not reset by `now`. */
function live(w: BudgetWindow, now: number): boolean {
  return w.remaining !== null && w.resetAt !== null && w.resetAt > now;
}

/** The more conservative of two readings of one window. */
function lowerWindow(
  a: BudgetWindow,
  b: BudgetWindow,
  now: number,
): BudgetWindow {
  if (!live(b, now)) return a;
  if (!live(a, now)) return b;
  if (a.resetAt === b.resetAt)
    return (b.remaining as number) < (a.remaining as number) ? b : a;
  return (b.resetAt as number) > (a.resetAt as number) ? b : a;
}

/**
 * Two records of one allowance merged conservatively: the later hold and
 * its reason, the higher count of refusals in a row, the lower balance of
 * each window.
 */
export function mergedRecord(
  a: BudgetRecord,
  b: BudgetRecord,
  now: number,
): BudgetRecord {
  const hold = (r: BudgetRecord) =>
    r.limitedUntil !== null && r.limitedUntil > now ? r.limitedUntil : null;
  const ha = hold(a);
  const hb = hold(b);
  const later = hb !== null && (ha === null || hb > ha) ? b : a;
  const names = new Set([
    ...Object.keys(a.windows ?? {}),
    ...Object.keys(b.windows ?? {}),
  ]);
  const empty: BudgetWindow = { limit: null, remaining: null, resetAt: null };
  const windows = Object.fromEntries(
    [...names].map((name) => [
      name,
      lowerWindow(a.windows?.[name] ?? empty, b.windows?.[name] ?? empty, now),
    ]),
  );
  const strikes = Math.max(a.strikes ?? 0, b.strikes ?? 0);
  return {
    requests: lowerWindow(a.requests, b.requests, now),
    complexity: lowerWindow(a.complexity, b.complexity, now),
    limitedUntil: hold(later),
    why: hold(later) === null ? null : later.why,
    observedAt: Math.max(a.observedAt, b.observedAt),
    ...(names.size === 0 ? {} : { windows }),
    ...(strikes === 0 ? {} : { strikes }),
  };
}

/**
 * The owner's record with the one window a `GET /user` answer reports (the
 * REST count) taken from the unverified record: that record is shared by
 * every unverified credential of the host, so its other windows and holds
 * belong to other users.
 */
function withDiscoveryWindow(
  owner: BudgetRecord | null,
  seen: BudgetRecord,
  now: number,
): BudgetRecord {
  const empty: BudgetWindow = { limit: null, remaining: null, resetAt: null };
  const base: BudgetRecord = owner ?? {
    requests: empty,
    complexity: empty,
    limitedUntil: null,
    why: null,
    observedAt: seen.observedAt,
  };
  return {
    ...base,
    requests: lowerWindow(base.requests, seen.requests, now),
    observedAt: Math.max(base.observedAt, seen.observedAt),
  };
}

/**
 * The owner's record with a credential's earlier record carried in: the
 * earlier record whole when the owner has none yet, else the two merged
 * conservatively, so no active hold is dropped.
 */
function carried(
  owner: BudgetRecord | null,
  earlier: BudgetRecord,
  now: number,
): BudgetRecord {
  return owner === null ? earlier : mergedRecord(owner, earlier, now);
}
