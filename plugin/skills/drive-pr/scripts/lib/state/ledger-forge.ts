/**
 * The drive ledger's forge side: reading the pull request's comments into a
 * `LedgerSnapshot`, writing the ledger by read-modify-write, posting a
 * takeover claim, and finding the open pull requests that carry a ledger.
 * Every call goes through `ghCall`, under its deadline.
 *
 * The forge has no compare-and-set on a comment, so the write is a
 * read-modify-write against the canonical comment's `updated_at`: the
 * comments are read, the new body built from them, and read again just
 * before the write; a ledger that moved in between is rebuilt from the newer
 * read, up to `WRITE_ATTEMPTS` times. That makes a silent overwrite of
 * another writer's ledger a race inside one request's latency rather than
 * inside a round. Two creations that race leave two comments: the lower id
 * is canonical, and each writer deletes its own higher-id copy on its next
 * write.
 */
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../../shared/outcome.ts";
import {
  forgeIdentityReused,
  forgeLogin,
} from "../../../../../shared/outbound/github-budget.ts";
import { localWriter } from "../../../../../shared/records/writer.ts";
import { ghCall } from "../proc.ts";
import {
  FORGE_BODY_LIMIT,
  type ForgeComment,
  type Ledger,
  type LedgerSnapshot,
  LEDGER_MARKER,
  renderClaim,
  renderLedger,
  snapshotFrom,
  type TakeoverClaim,
} from "./ledger.ts";

const WRITE_ATTEMPTS = 3;

const abortReason = (signal: AbortSignal | undefined): string | null =>
  signal?.aborted ? "the collector deadline passed" : null;

/** One forge call's output, or why it failed: its exit and last error line. `timeoutSec` shortens the call's deadline. */
export async function forge(
  args: string[],
  stdin?: string,
  timeoutSec?: number,
  signal?: AbortSignal,
): Promise<
  { ok: true; stdout: string } | { ok: false; why: string; unsent?: true }
> {
  const aborted = abortReason(signal);
  if (aborted !== null) return { ok: false, why: aborted, unsent: true };
  // A signal that fires while the call runs ends the child, so the call does not outlive the caller's deadline.
  let stop: (() => void) | undefined;
  const r = await ghCall(args, {
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin }),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
    ...(signal === undefined
      ? {}
      : {
          onSpawn: (handle) => {
            stop = () => void handle.stop();
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
          },
        }),
  });
  if (stop !== undefined) signal?.removeEventListener("abort", stop);
  if (r.code === 0) return { ok: true, stdout: r.stdout };
  const tail = r.stderr.trim().split("\n").at(-1) ?? "";
  return {
    ok: false,
    why: `gh exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
    ...(r.held !== undefined || r.spawnFailed ? { unsent: true } : {}),
  };
}

/** `text` as JSON, or `undefined` when it is not. */
function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    swallow(err, `${what} printed no JSON`);
    return undefined;
  }
}

type LoginRead = Outcome<string, "unreadable" | "malformed">;
type DirectLoginRead = LoginRead & { unsent?: true };

let directLogin: Promise<DirectLoginRead> | undefined;

/** Let one collector stop waiting without cancelling the shared identity lookup. */
async function whileActive<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  aborted: () => T,
): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) return aborted();
  let stop: (() => void) | undefined;
  const stopped = new Promise<T>((resolve) => {
    stop = () => resolve(aborted());
    signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([pending, stopped]).finally(() => {
    if (stop !== undefined) signal.removeEventListener("abort", stop);
  });
}

/** Resolve the authenticated actor through the forge transport. */
export async function readLogin(
  timeoutSec?: number,
  signal?: AbortSignal,
): Promise<LoginRead> {
  if (signal?.aborted)
    return failed("unreadable", "the collector deadline passed");
  // Other commands use this reader too, including a dispatcher that can
  // visit repositories routed to different accounts in the same process.
  if (!forgeIdentityReused()) return readDirectLogin(timeoutSec, signal);
  const login = await whileActive(
    forgeLogin(timeoutSec === undefined ? undefined : timeoutSec * 1000),
    signal,
    () => undefined,
  );
  if (signal?.aborted)
    return failed("unreadable", "the collector deadline passed");
  if (login !== undefined)
    return login.ok
      ? login
      : failed(
          login.failure.code === "invalid" ? "malformed" : "unreadable",
          login.failure.reason,
        );
  directLogin ??= readDirectLogin(timeoutSec, signal);
  const attempt = directLogin;
  const read = await attempt;
  if (!read.ok && directLogin === attempt) directLogin = undefined;
  return read;
}

/** Quota discovery is inactive for some credentials and when the budget is off. */
async function readDirectLogin(
  timeoutSec?: number,
  signal?: AbortSignal,
): Promise<DirectLoginRead> {
  const r = await forge(
    ["api", "user", "--jq", ".login"],
    undefined,
    timeoutSec,
    signal,
  );
  if (!r.ok)
    return {
      ...failed("unreadable", r.why),
      ...(r.unsent ? { unsent: true } : {}),
    };
  const login = r.stdout.trim();
  if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(login))
    return failed("malformed", "the answer names no login");
  return ok(login);
}

/** The login the forge client is signed in as; `null` when it cannot say. */
export async function resolveLogin(
  timeoutSec?: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const read = await readLogin(timeoutSec, signal);
  return read.ok ? read.value : null;
}

function forgeComment(c: unknown): ForgeComment | null {
  if (!isRecord(c) || typeof c.id !== "number") return null;
  const user = isRecord(c.user) ? c.user : {};
  return {
    id: c.id,
    login: typeof user.login === "string" ? user.login : "",
    association:
      typeof c.author_association === "string" ? c.author_association : "",
    updatedAt: typeof c.updated_at === "string" ? c.updated_at : "",
    body: typeof c.body === "string" ? c.body : "",
  };
}

function isCompleteComment(c: unknown): boolean {
  if (!isRecord(c) || !isPositiveId(c.id)) return false;
  if (!hasCommentText(c)) return false;
  return c.user === null || hasLogin(c.user);
}

function isPositiveId(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasCommentText(comment: Record<string, unknown>): boolean {
  return (
    typeof comment.body === "string" &&
    typeof comment.updated_at === "string" &&
    typeof comment.author_association === "string"
  );
}

function hasLogin(value: unknown): boolean {
  return isRecord(value) && typeof value.login === "string";
}

function commentPages(pages: unknown): unknown[][] | string {
  const out = Array.isArray(pages) ? pages : [pages];
  if (out.some((page) => !Array.isArray(page)))
    return "the comment listing is not a list";
  return out;
}

function completePages(pages: readonly unknown[][]): string | null {
  if (pages.length === 0) return "the comment listing has no pages";
  for (const page of pages)
    if (page.some((comment) => !isCompleteComment(comment)))
      return "the comment listing has an incomplete comment";
  return null;
}

function forgeComments(pages: readonly unknown[][]): ForgeComment[] {
  return pages.flatMap((page) =>
    page
      .map(forgeComment)
      .filter((comment): comment is ForgeComment => comment !== null),
  );
}

/**
 * Every comment on the pull request, or why they could not be read. `repo`
 * (`owner/name`) names the repository; without it, the current directory's.
 * Read fresh, never an evaluation's shared reading (`../paged-read.ts`): it
 * decides whether a ledger comment is written or which one is edited.
 */
async function listComments(
  pr: string,
  repo = "{owner}/{repo}",
  signal?: AbortSignal,
): Promise<ForgeComment[] | string> {
  const r = await forge(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${pr}/comments?per_page=100`,
    ],
    undefined,
    undefined,
    signal,
  );
  if (!r.ok) return r.why;
  const pages = commentPages(json(r.stdout, "the comment listing"));
  return typeof pages === "string" ? pages : forgeComments(pages);
}

/**
 * What a listing of the pull request's comments already read (the forge's
 * issue-comment objects) says about its drive, for a reader that shares one
 * listing between the ledger and other records.
 */
export function snapshotFromListing(
  listing: readonly unknown[],
  selfLogin: string | null,
): LedgerSnapshot {
  const comments = listing
    .map(forgeComment)
    .filter((c): c is ForgeComment => c !== null);
  return snapshotFrom(comments, selfLogin);
}

/** What the pull request's comments say about its drive, or why they could not be read. */
export async function readLedgerSnapshot(
  pr: string,
  selfLogin: string | null,
  repo?: string,
  signal?: AbortSignal,
): Promise<LedgerSnapshot | string> {
  const aborted = abortReason(signal);
  if (aborted !== null) return aborted;
  const comments = await listComments(pr, repo, signal);
  return snapshotFromComments(comments, selfLogin);
}

/** A listing complete enough to defer the next round-boundary takeover check. */
export async function readCompleteLedgerSnapshot(
  pr: string,
  selfLogin: string | null,
): Promise<LedgerSnapshot | string> {
  const r = await forge([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
  ]);
  if (!r.ok) return snapshotFromComments(r.why, selfLogin);
  const pages = commentPages(json(r.stdout, "the comment listing"));
  if (typeof pages === "string") return snapshotFromComments(pages, selfLogin);
  const complete = completePages(pages);
  const comments = complete === null ? forgeComments(pages) : complete;
  return snapshotFromComments(comments, selfLogin);
}

function snapshotFromComments(
  comments: ForgeComment[] | string,
  selfLogin: string | null,
): LedgerSnapshot | string {
  return typeof comments === "string"
    ? `the comments could not be read (${comments})`
    : snapshotFrom(comments, selfLogin);
}

/** The id of a comment just posted, or why the post failed. */
async function postComment(pr: string, body: string): Promise<number | string> {
  const r = await forge(
    ["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--input", "-"],
    JSON.stringify({ body }),
  );
  if (!r.ok) return r.why;
  const posted = json(r.stdout, "the posted comment");
  return isRecord(posted) && typeof posted.id === "number"
    ? posted.id
    : "the forge answered the post without a comment id";
}

async function patchComment(id: number, body: string): Promise<string> {
  const r = await forge(
    [
      "api",
      "-X",
      "PATCH",
      `repos/{owner}/{repo}/issues/comments/${id}`,
      "--input",
      "-",
    ],
    JSON.stringify({ body }),
  );
  return r.ok ? "" : r.why;
}

async function deleteComment(id: number): Promise<boolean> {
  const r = await forge([
    "api",
    "-X",
    "DELETE",
    `repos/{owner}/{repo}/issues/comments/${id}`,
  ]);
  return r.ok;
}

export type LedgerWrite =
  | {
      kind: "written";
      id: number;
      generation: number;
      cut: string[];
      deleted: number[];
    }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** Whether the canonical ledger changed since `canonical` was read. */
function moved(reread: LedgerSnapshot, canonical: ForgeComment): boolean {
  const now = reread.canonical?.comment;
  // `updated_at` has one-second precision: a write in the same second moves
  // the body and not the stamp.
  return (
    now?.id !== canonical.id ||
    now.updatedAt !== canonical.updatedAt ||
    now.body !== canonical.body
  );
}

/**
 * Read the ledger back after a write: `''` when the canonical comment holds
 * this write's body, else what replaced it. The body, not its generation
 * and heartbeat: two writers building from one generation in the same
 * millisecond carry the same pair and different state. A read that fails is
 * no evidence either way, and the write stands.
 */
async function replacedBy(
  pr: string,
  selfLogin: string | null,
  id: number,
  body: string,
): Promise<string> {
  const back = await readLedgerSnapshot(pr, selfLogin);
  if (typeof back === "string") return "";
  if (back.canonical?.comment.id === id && back.canonical.comment.body === body)
    return "";
  const parsed = back.canonical?.parsed;
  const theirs = parsed?.kind === "ledger" ? parsed.ledger : null;
  return theirs === null
    ? "a comment this version does not read"
    : `generation ${theirs.generation}, written at ${theirs.driver.heartbeat}`;
}

/** Delete the duplicates of the canonical ledger this login created. */
async function deleteOwnDuplicates(
  snapshot: LedgerSnapshot,
  selfLogin: string | null,
): Promise<number[]> {
  const deleted: number[] = [];
  const own = snapshot.duplicates.filter(
    (dup) => selfLogin !== null && dup.login === selfLogin,
  );
  for (const dup of own) if (await deleteComment(dup.id)) deleted.push(dup.id);
  return deleted;
}

/** The body this snapshot gets, or why there is none to write. */
function bodyFor(
  snapshot: LedgerSnapshot,
  build: (snapshot: LedgerSnapshot) => Ledger | string,
  selfLogin: string | null,
): { body: string; ledger: Ledger } | LedgerWrite {
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind === "unknown-version")
    return {
      kind: "failed",
      reason: `the ledger on the pull request is ledgerVersion ${String(parsed.version)}, which this version does not read; not overwriting it`,
    };
  const ledger = build(snapshot);
  if (typeof ledger === "string") return { kind: "skipped", reason: ledger };
  const rendered = renderLedger(
    ledger,
    FORGE_BODY_LIMIT,
    localWriter("forge", selfLogin),
  );
  return "error" in rendered
    ? { kind: "failed", reason: rendered.error }
    : rendered;
}

function written(
  id: number,
  ledger: Ledger,
  deleted: number[] = [],
): LedgerWrite {
  return {
    kind: "written",
    id,
    generation: ledger.generation,
    cut: ledger.cut,
    deleted,
  };
}

/**
 * Update the canonical ledger, read it back, and delete this login's own
 * duplicates once the write stands.
 */
async function patchAndVerify(
  pr: string,
  selfLogin: string | null,
  snapshot: LedgerSnapshot,
  canonical: ForgeComment,
  next: { body: string; ledger: Ledger },
): Promise<LedgerWrite> {
  const patched = await patchComment(canonical.id, next.body);
  if (patched !== "")
    return {
      kind: "failed",
      reason: `the ledger comment was not updated (${patched})`,
    };
  const replaced = await replacedBy(pr, selfLogin, canonical.id, next.body);
  if (replaced !== "")
    return {
      kind: "failed",
      reason: `another writer replaced this write at once (${replaced}); that one stands`,
    };
  return written(
    canonical.id,
    next.ledger,
    await deleteOwnDuplicates(snapshot, selfLogin),
  );
}

/**
 * Write the ledger `build` makes from the current comments; `build` returns
 * a reason string to skip the write. A canonical ledger in a version this
 * code does not read is never overwritten.
 */
export async function writeLedger(
  pr: string,
  selfLogin: string | null,
  build: (snapshot: LedgerSnapshot) => Ledger | string,
): Promise<LedgerWrite> {
  let snapshot = await readLedgerSnapshot(pr, selfLogin);
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    if (typeof snapshot === "string")
      return { kind: "failed", reason: snapshot };
    const done = await writeOnce(pr, selfLogin, snapshot, build);
    if ("kind" in done) return done;
    snapshot = done.moved;
  }
  return {
    kind: "failed",
    reason: `the ledger changed under each of ${WRITE_ATTEMPTS} writes`,
  };
}

/**
 * One write attempt from `snapshot`: its outcome, or the newer read to
 * rebuild from when the ledger moved (or became unreadable) under it.
 */
async function writeOnce(
  pr: string,
  selfLogin: string | null,
  snapshot: LedgerSnapshot,
  build: (snapshot: LedgerSnapshot) => Ledger | string,
): Promise<LedgerWrite | { moved: LedgerSnapshot | string }> {
  const next = bodyFor(snapshot, build, selfLogin);
  if ("kind" in next) return next;
  const canonical = snapshot.canonical?.comment ?? null;
  if (canonical === null) {
    const id = await postComment(pr, next.body);
    return typeof id === "string"
      ? { kind: "failed", reason: `the ledger comment was not created (${id})` }
      : written(id, next.ledger);
  }
  const reread = await readLedgerSnapshot(pr, selfLogin);
  if (typeof reread === "string" || moved(reread, canonical))
    return { moved: reread };
  // The ledger stood still, but a claim may have arrived beside it: the body
  // written is the one the newest read allows.
  const final = bodyFor(reread, build, selfLogin);
  if ("kind" in final) return final;
  return patchAndVerify(pr, selfLogin, reread, canonical, final);
}

/** Post a takeover claim: its comment id, or why the post failed. */
export function postClaim(
  pr: string,
  claim: TakeoverClaim,
): Promise<number | string> {
  return postComment(pr, renderClaim(claim));
}

export interface LedgerPullRequest {
  number: number;
  url: string;
  title: string;
  /** The pull request's author's login, `''` when the search did not say. */
  author: string;
  /** The ledger its comments hold, and the login that wrote it. */
  ledger: Ledger;
  ledgerBy: string;
}

export type SearchHit = Omit<LedgerPullRequest, "ledger" | "ledgerBy">;

/** The ledger search's pull requests, and each hit whose comments could not be read. */
export interface LedgerSearch {
  found: LedgerPullRequest[];
  /** One sentence per hit whose ledger could not be read. */
  unread: string[];
}

/** The open pull requests of the current repository matching `qualifier`; `null` when the search cannot be run. */
async function searchOpenPullRequests(
  qualifier: string,
): Promise<SearchHit[] | null> {
  const repo = await forge([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  const name = repo.ok ? repo.stdout.trim() : "";
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) return null;
  const r = await forge([
    "api",
    "-X",
    "GET",
    "--paginate",
    "--slurp",
    "search/issues",
    "-f",
    `q=repo:${name} is:pr is:open ${qualifier}`,
    "-f",
    "per_page=100",
  ]);
  return r.ok ? searchResults(json(r.stdout, "the search")) : null;
}

/**
 * The open pull requests of the current repository that carry a drive
 * ledger: the forge's search (the ledger's visible summary names
 * `drive-pr-ledger`, which the search indexes) narrowed to the pull requests
 * whose comments hold a trusted ledger this version reads, since a comment
 * that merely mentions the marker matches the search too. A hit whose
 * comments could not be read is named in `unread`, never dropped as one
 * without a ledger. `null` when the search cannot be run. The population a
 * morning report reads; narrowing it to the pull requests this account
 * drove is the report's own step.
 */
export async function listLedgerPullRequests(): Promise<LedgerSearch | null> {
  const marker = LEDGER_MARKER.replace(/^<!-- | -->$/g, "");
  const hits = await searchOpenPullRequests(`in:comments "${marker}"`);
  if (hits === null) return null;
  const login = await resolveLogin();
  const found: LedgerPullRequest[] = [];
  const unread: string[] = [];
  for (const hit of hits) {
    const held = await ledgerOf(String(hit.number), login);
    if (typeof held === "string")
      unread.push(`#${hit.number}'s drive ledger could not be read: ${held}`);
    else if (held !== null) found.push({ ...hit, ...held });
  }
  return { found, unread };
}

/** The open pull requests of the current repository `login` authored; `null` when the search cannot be run. */
export function listAuthoredPullRequests(
  login: string,
): Promise<SearchHit[] | null> {
  return searchOpenPullRequests(`author:${login}`);
}

/**
 * The trusted ledger this version reads on the pull request, and its
 * writer; `null` for none, and why when its comments could not be read or
 * its canonical ledger cannot be interpreted (a newer version, or malformed).
 */
async function ledgerOf(
  pr: string,
  login: string | null,
): Promise<{ ledger: Ledger; ledgerBy: string } | null | string> {
  const snapshot = await readLedgerSnapshot(pr, login);
  if (typeof snapshot === "string") return snapshot;
  const canonical = snapshot.canonical;
  const damaged = snapshot.malformed[0];
  if (canonical === null)
    return damaged === undefined
      ? null
      : `its ledger (comment ${damaged.id}) is malformed: its data does not read`;
  const parsed = canonical.parsed;
  if (parsed.kind === "ledger")
    return { ledger: parsed.ledger, ledgerBy: canonical.comment.login };
  return parsed.kind === "unknown-version"
    ? `its ledger (comment ${canonical.comment.id}) has version ${JSON.stringify(parsed.version)}, which this version does not read`
    : `its ledger (comment ${canonical.comment.id}) is malformed: ${parsed.reason}`;
}

/**
 * The pull requests in the search's pages (`--slurp`: an array of pages,
 * each with an `items` array), by number; `null` when the response is not
 * that shape, so an unreadable search is never an empty one.
 */
function searchResults(pages: unknown): SearchHit[] | null {
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    !pages.every(
      (page) =>
        isRecord(page) &&
        Array.isArray(page.items) &&
        page.incomplete_results !== true,
    )
  )
    return null;
  const items = pages.flatMap((page) => (page as { items: unknown[] }).items);
  return items
    .filter(
      (
        it,
      ): it is Record<string, unknown> & { number: number; html_url: string } =>
        isRecord(it) &&
        typeof it.number === "number" &&
        typeof it.html_url === "string",
    )
    .map((it) => ({
      number: it.number,
      url: it.html_url,
      title: typeof it.title === "string" ? it.title : "",
      author:
        isRecord(it.user) && typeof it.user.login === "string"
          ? it.user.login
          : "",
    }))
    .sort((a, b) => a.number - b.number);
}
