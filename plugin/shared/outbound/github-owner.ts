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
 * - **The stored login is asked per repository.** A client may pick its
 *   account by the repository a command addresses, so the stored login's
 *   mapping is kept per repository a run addresses (its scope,
 *   `github-scope.ts`): under a hash of the credential's key and the
 *   repository, and the question is asked with `GH_REPO` set to that
 *   repository, from the run's working directory, so the client picks the
 *   account it picks for the run. That is one `GET /user` a day for each
 *   repository a stored login addresses. A run that addresses no repository
 *   keeps the credential's own key. A token names its own user whatever the
 *   repository: its mapping has no scope.
 * - **A refusal names whose allowance is spent.** GitHub's "rate limit
 *   exceeded for user ID N" is held on user N's record when the run was
 *   admitted against another (`github-budget.ts`), and the mapping is taken
 *   to be user N's until it is asked again, which the next run does.
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
import { errnoCode, swallow } from "../errors.ts";
import { isGithubLogin } from "../forge-logins.ts";
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
import { scopedCredential } from "./github-scope.ts";
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
/** How often a refused carry is tried again while the call waits for it. */
const SETTLE_POLL_MS = 25;

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
      if (db !== null)
        inTransaction(
          db,
          () =>
            db
              ?.query("DELETE FROM github_owner WHERE retry_at < ?")
              .run(clock() - OWNER_RETENTION_MS),
          0,
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
        inTransaction(
          d,
          () => {
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
            // A held lock is not waited for: the entry is rewritten at the next
            // check, and a one-second call cannot wait ten seconds on it.
          },
          0,
        );
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

/** Ask who the credential `env` names is, within `deadlineMs`, from the working directory `cwd` (the process's when left out). */
export type DiscoverUser = (
  env: Env,
  deadlineMs: number,
  cwd?: string,
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
      isGithubLogin(login, { bot: true })
      ? { id, login }
      : null;
  } catch (error) {
    swallow(error, "an answer to GET /user that is not JSON names no user");
    return null;
  }
}

/** Runs `gh` with `args` as the forge client does: bounded, admitted and recorded; in `cwd` when given. */
export type GhRunner = (
  args: string[],
  env: Env,
  timeoutSec: number,
  cwd?: string,
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
const ghUser: DiscoverUser = async (env, deadlineMs, cwd) => {
  if (runner === null)
    return {
      failure: outboundFailure("unauthorized", "no gh runner to ask with"),
    };
  const began = currentMs();
  const result = await runner(
    ["api", "user"],
    env,
    Math.max(1, Math.ceil(deadlineMs / 1000)),
    cwd,
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
  /** Whose allowance the owner's record keeps, for a person: `GitHub account <login>`, `installation <id>`, `user ID <id>`, or the host's shared record. */
  account: string;
}

/**
 * Finds and remembers credentials' owners. `scope` is the repository a run
 * of the stored login addresses (`github-scope.ts`): its owner is asked and
 * kept for that repository, with `GH_REPO` set to it for the question and
 * from the run's working directory `cwd`. A token's owner has no scope.
 */
export interface GithubOwnerResolver {
  /** The owner, asking GitHub at most once a check period. */
  resolve(
    env: Env,
    deadlineMs?: number,
    scope?: string | null,
    cwd?: string,
  ): Promise<OwnerResolution>;
  /** The owner the machine already knows, sending nothing; `null` for a credential never asked. */
  known(env: Env, scope?: string | null): OwnerResolution | null;
  /**
   * GitHub refused a run of this credential and scope for the allowance of
   * user `userId`, not the owner it was admitted against: the mapping is
   * taken to be that user's until it is asked again, which the next run
   * does.
   */
  misattributed(env: Env, scope: string | null, userId: number): void;
}

/** The phrase for the host's shared record, which holds no one account's allowance. */
export function unverifiedAccount(host: string): string {
  return `the shared record of the credentials whose account is not established on ${host}`;
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
  /** Waits `ms`; give it with a pinned `clock` so contention can be tested without real time. */
  sleep?: (ms: number) => Promise<void>;
}): GithubOwnerResolver {
  const clock = deps.clock ?? currentMs;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const discover = deps.discover ?? ghUser;
  const memo = new Map<
    string,
    { resolution: OwnerResolution; until: number }
  >();
  const inflight = new Map<string, Promise<OwnerResolution>>();
  const seeded = new Set<string>();
  /** Discovery windows not yet carried to their owner, by owner, until the lock is free. */
  const unsettled = new Map<string, BudgetRecord>();

  /** `user ID <id>` for each user record a refusal named, by its key: the record's key cannot be read back. */
  const named = new Map<string, string>();

  const unverified = (env: Env, credential: string): OwnerResolution => ({
    credential,
    owner: unverifiedOwner(githubHost(env)),
    verified: false,
    login: null,
    account: unverifiedAccount(githubHost(env)),
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
          account: `installation ${id}`,
        };
  };

  const fromEntry = (
    env: Env,
    credential: string,
    e: OwnerEntry,
  ): OwnerResolution => ({
    credential,
    owner: e.owner,
    verified: e.verified,
    login: e.login,
    account: !e.verified
      ? unverifiedAccount(githubHost(env))
      : e.login !== null
        ? `GitHub account ${e.login}`
        : (named.get(e.owner) ??
          "the GitHub account a rate-limit refusal named"),
  });

  /** The key the owner of `credential` is kept under for `scope`; a token's owner has no scope. */
  const slotOf = (env: Env, credential: string, scope?: string | null) =>
    scopedCredential(credential, githubToken(env) === null ? scope : null);

  /** Carry the credential's earlier record into its owner's, once a process; `false` while the lock refuses it. */
  const seed = (env: Env, owner: string): boolean => {
    const legacy = legacyGithubCredential(env);
    const pair = `${legacy}>${owner}`;
    if (legacy === owner || seeded.has(pair)) return true;
    const earlier = deps.budget.read(legacy);
    if (earlier === null) {
      seeded.add(pair);
      return true;
    }
    const now = clock();
    if (
      !whenFree(() =>
        deps.budget.update(owner, (p) => carried(p, earlier, now), true),
      )
    )
      return false;
    seeded.add(pair);
    return true;
  };

  /** Complete every carry owed to `owner`; `false` while the lock refuses one, to be tried again. */
  const settleOnce = (env: Env, owner: string): boolean => {
    let done = seed(env, owner);
    const seen = unsettled.get(owner);
    if (seen === undefined) return done;
    if (
      whenFree(() =>
        deps.budget.update(
          owner,
          (prev) => withDiscoveryWindow(prev, seen, clock()),
          true,
        ),
      )
    )
      unsettled.delete(owner);
    else done = false;
    return done;
  };

  /**
   * Complete the carries before the owner is used, so a call is admitted
   * against the owner's record and not an absent one: the lock is waited for
   * until the call's absolute deadline `until`, and a carry still refused
   * then is tried again at the next resolve.
   */
  const settle = async (
    env: Env,
    owner: string,
    until: number,
  ): Promise<void> => {
    while (!settleOnce(env, owner) && clock() < until)
      await sleep(SETTLE_POLL_MS);
  };

  const ask = async (
    env: Env,
    credential: string,
    asked: Question,
    entry: OwnerEntry | null,
    until: number,
  ): Promise<OwnerResolution> => {
    const now = clock();
    const deadlineMs = Math.min(
      DISCOVERY_DEADLINE_MS,
      Math.max(0, until - now),
    );
    const fallback = unverified(env, credential);
    // The request is admitted, observed and recorded as any run of `gh` is,
    // against the unverified record, the owner not being known yet.
    // While the unverified record is held nothing is sent.
    try {
      deps.governor?.admit("GitHub", fallback.owner, {
        windows: ["requests"],
        reserve: null,
        nonblocking: true,
      });
    } catch (error) {
      // A busy store sends nothing either: discovery waits for a later check.
      if (!isRateLimited(error)) busyOrThrow(error);
      return entry?.verified === true
        ? fromEntry(env, credential, entry)
        : fallback;
    }
    const began = currentMs();
    const answer = await discover(asked.env, deadlineMs, asked.cwd);
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
      if (seen !== null && seen.observedAt >= began) {
        // Carried at the owner's next resolve when the lock is held.
        unsettled.set(owner, seen);
        await settle(env, owner, until);
      }
    }
    // The default discovery is a run of `gh` the wrapper records itself; a
    // discovery given in its place is recorded here.
    if (deps.discover !== undefined)
      ledgerLookup(credential, owner, answer, currentMs() - began);
    const next = nextEntry(user, owner, entry, now, githubToken(env) !== null);
    deps.owners.write(asked.slot, githubHost(env), next);
    return fromEntry(env, credential, next);
  };

  const known = (env: Env, scope?: string | null): OwnerResolution | null => {
    const credential = githubCredential(env);
    if (installationToken(env)) return installation(env, credential);
    const entry = deps.owners.read(
      slotOf(env, credential, scope),
      githubHost(env),
    );
    return entry === null ? null : fromEntry(env, credential, entry);
  };

  const misattributed = (
    env: Env,
    scope: string | null,
    userId: number,
  ): void => {
    const credential = githubCredential(env);
    if (installationToken(env)) return;
    const host = githubHost(env);
    const key = slotOf(env, credential, scope);
    const owner = userOwner(host, userId);
    named.set(owner, `user ID ${userId}`);
    memo.delete(`${key}@${host}`);
    // Kept as the named user's until the next run asks again: a run that
    // cannot ask (the shared record held, a busy store) is admitted
    // against the allowance GitHub named.
    const now = clock();
    deps.owners.write(key, host, {
      owner,
      verified: true,
      login: null,
      checkedAt: now,
      retryAt: now,
    });
  };

  const resolve = async (
    env: Env,
    deadlineMs: number = DISCOVERY_DEADLINE_MS,
    scope: string | null = null,
    cwd?: string,
  ): Promise<OwnerResolution> => {
    const credential = githubCredential(env);
    // One deadline for the whole resolution, however many settlements and
    // discoveries it spends it on.
    const until = clock() + Math.max(0, deadlineMs);
    if (installationToken(env)) {
      const found = installation(env, credential);
      await settle(env, found.owner, until);
      return found;
    }
    const now = clock();
    const host = githubHost(env);
    const key = slotOf(env, credential, scope);
    const slot = `${key}@${host}`;
    const held = memo.get(slot);
    if (held !== undefined && held.until > now) {
      await settle(env, held.resolution.owner, until);
      return held.resolution;
    }
    const pending = inflight.get(slot);
    if (pending !== undefined) return within(pending, env, deadlineMs, until);
    const entry = deps.owners.read(key, host);
    if (entry !== null && entry.retryAt > now) {
      const found = fromEntry(env, credential, entry);
      memo.set(slot, { resolution: found, until: entry.retryAt });
      await settle(env, found.owner, until);
      return found;
    }
    const asked = ask(
      env,
      credential,
      question(env, key, scope, cwd),
      entry,
      until,
    )
      .then(async (found) => {
        // A refused admission stores nothing: the process waits out the
        // backoff before it asks again.
        const retryAt = deps.owners.read(key, host)?.retryAt ?? 0;
        memo.set(slot, {
          resolution: found,
          until: retryAt > clock() ? retryAt : clock() + DISCOVERY_BACKOFF_MS,
        });
        await settle(env, found.owner, until);
        return found;
      })
      .finally(() => inflight.delete(slot));
    inflight.set(slot, asked);
    return asked;
  };

  /**
   * A caller's wait on a shared discovery, bounded by its own deadline; the
   * discovery goes on for the others. The initiator settled the carries under
   * its own deadline, which may have been shorter: each joining caller
   * completes them under its own before the owner is used.
   */
  const within = async (
    pending: Promise<OwnerResolution>,
    env: Env,
    deadlineMs: number,
    until: number,
  ): Promise<OwnerResolution> => {
    const bound = Math.min(DISCOVERY_DEADLINE_MS, deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<OwnerResolution>((resolve) => {
      timer = setTimeout(
        () => resolve(unverified(env, githubCredential(env))),
        Math.max(0, bound),
      );
    });
    const found = await Promise.race([pending, expired]).finally(() =>
      clearTimeout(timer),
    );
    await settle(env, found.owner, until);
    return found;
  };

  return { resolve, known, misattributed };
}

/** Where a discovery's answer is kept, and how the question is asked. */
interface Question {
  /** The key the owner is kept under. */
  slot: string;
  /** The environment the question is asked with. */
  env: Env;
  /** The working directory it is asked from; the process's when left out. */
  cwd?: string;
}

/**
 * The question for the owner kept under `slot`: a stored login whose run
 * addresses the repository `scope` is asked with `GH_REPO` set to it and
 * from the run's directory, so a client that picks its account per
 * repository picks it for the question as it does for the run.
 */
function question(
  env: Env,
  slot: string,
  scope: string | null,
  cwd: string | undefined,
): Question {
  const scoped = scope !== null && githubToken(env) === null;
  return {
    slot,
    env: scoped ? { ...env, GH_REPO: scope } : env,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** Rethrow `error` unless it is a store's contention. */
function busyOrThrow(error: unknown): void {
  if (errnoCode(error) !== "SQLITE_BUSY") throw error;
}

/** Run a nonblocking store write; `false` when the store's lock was held. */
function whenFree(write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    busyOrThrow(error);
    return false;
  }
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

/** The owner record a discovery leaves: verified by an answer, else backed off. */
function nextEntry(
  user: GithubUser | null,
  owner: string,
  entry: OwnerEntry | null,
  now: number,
  hasToken: boolean,
): OwnerEntry {
  if (user !== null)
    return {
      owner,
      verified: true,
      login: user.login,
      checkedAt: now,
      retryAt: now + (hasToken ? TOKEN_OWNER_TTL_MS : LOGIN_OWNER_TTL_MS),
    };
  return {
    owner,
    verified: entry?.verified === true,
    login: entry?.login ?? null,
    checkedAt: now,
    retryAt: now + DISCOVERY_BACKOFF_MS,
  };
}
