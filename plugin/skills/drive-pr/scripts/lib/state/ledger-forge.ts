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
import { ghCall } from "../proc.ts";
import {
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

/** One forge call's output, or why it failed: its exit and last error line. */
async function forge(
  args: string[],
  stdin?: string,
): Promise<{ ok: true; stdout: string } | { ok: false; why: string }> {
  const r = await ghCall(args, {
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (r.code === 0) return { ok: true, stdout: r.stdout };
  const tail = r.stderr.trim().split("\n").at(-1) ?? "";
  return {
    ok: false,
    why: `gh exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
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

/** The login the forge client is signed in as; `null` when it cannot say. */
export async function resolveLogin(): Promise<string | null> {
  const r = await forge(["api", "user", "--jq", ".login"]);
  const login = r.ok ? r.stdout.trim() : "";
  return /^[A-Za-z0-9-]+(\[bot\])?$/.test(login) ? login : null;
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

/** Every comment on the pull request, or why they could not be read. */
async function listComments(pr: string): Promise<ForgeComment[] | string> {
  const r = await forge([
    "api",
    "--paginate",
    "--slurp",
    `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
  ]);
  if (!r.ok) return r.why;
  const pages = json(r.stdout, "the comment listing");
  const out: ForgeComment[] = [];
  for (const page of Array.isArray(pages) ? pages : [pages]) {
    if (!Array.isArray(page)) return "the comment listing is not a list";
    for (const c of page) {
      const comment = forgeComment(c);
      if (comment !== null) out.push(comment);
    }
  }
  return out;
}

/** What the pull request's comments say about its drive, or why they could not be read. */
export async function readLedgerSnapshot(
  pr: string,
  selfLogin: string | null,
): Promise<LedgerSnapshot | string> {
  const comments = await listComments(pr);
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
 * Read the ledger back after a write: `''` when it holds this write, else
 * what replaced it. A read that fails is no evidence either way, and the
 * write stands.
 */
async function replacedBy(
  pr: string,
  selfLogin: string | null,
  ours: Ledger,
): Promise<string> {
  const back = await readLedgerSnapshot(pr, selfLogin);
  if (typeof back === "string") return "";
  const parsed = back.canonical?.parsed;
  const theirs = parsed?.kind === "ledger" ? parsed.ledger : null;
  if (
    theirs !== null &&
    theirs.generation === ours.generation &&
    theirs.driver.heartbeat === ours.driver.heartbeat
  )
    return "";
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
): { body: string; ledger: Ledger } | LedgerWrite {
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind === "unknown-version")
    return {
      kind: "failed",
      reason: `the ledger on the pull request is ledgerVersion ${String(parsed.version)}, which this version does not read; not overwriting it`,
    };
  const ledger = build(snapshot);
  if (typeof ledger === "string") return { kind: "skipped", reason: ledger };
  const rendered = renderLedger(ledger);
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
  const replaced = await replacedBy(pr, selfLogin, next.ledger);
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
  const next = bodyFor(snapshot, build);
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
  const final = bodyFor(reread, build);
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

type SearchHit = Omit<LedgerPullRequest, "ledger" | "ledgerBy">;

/**
 * The open pull requests of the current repository that carry a drive
 * ledger: the forge's search (the ledger's visible summary names
 * `drive-pr-ledger`, which the search indexes) narrowed to the pull requests
 * whose comments hold a trusted ledger this version reads, since a comment
 * that merely mentions the marker matches the search too. `null` when the
 * search cannot be run. The population a morning report reads; narrowing it
 * to the pull requests this account drove is the report's own step.
 */
export async function listLedgerPullRequests(): Promise<
  LedgerPullRequest[] | null
> {
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
  const marker = LEDGER_MARKER.replace(/^<!-- | -->$/g, "");
  const r = await forge([
    "api",
    "-X",
    "GET",
    "--paginate",
    "--slurp",
    "search/issues",
    "-f",
    `q=repo:${name} is:pr is:open in:comments "${marker}"`,
    "-f",
    "per_page=100",
  ]);
  if (!r.ok) return null;
  const login = await resolveLogin();
  const found: LedgerPullRequest[] = [];
  for (const hit of searchResults(json(r.stdout, "the search"))) {
    const held = await ledgerOf(String(hit.number), login);
    if (held !== null) found.push({ ...hit, ...held });
  }
  return found;
}

/** The trusted ledger this version reads on the pull request, and its writer; `null` for none. */
async function ledgerOf(
  pr: string,
  login: string | null,
): Promise<{ ledger: Ledger; ledgerBy: string } | null> {
  const snapshot = await readLedgerSnapshot(pr, login);
  if (typeof snapshot === "string") return null;
  const canonical = snapshot.canonical;
  return canonical?.parsed.kind === "ledger"
    ? { ledger: canonical.parsed.ledger, ledgerBy: canonical.comment.login }
    : null;
}

/** The pull requests in the search's pages, by number. */
function searchResults(pages: unknown): SearchHit[] {
  const items = (Array.isArray(pages) ? pages : [pages]).flatMap((page) =>
    isRecord(page) && Array.isArray(page.items) ? page.items : [],
  );
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
