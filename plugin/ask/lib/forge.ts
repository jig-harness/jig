/**
 * What `jig ask` reads on the forge: a pull request, its comments, its
 * timeline, the login the forge client is signed in as and, for `jig send`,
 * the repository's configuration on its default branch. Every read is a
 * conditional request (`shared/gh-conditional.ts`), so a resource that has
 * not changed since the last read on this machine costs nothing against the
 * forge's limit, which every drive on the machine shares; each is counted,
 * runs under its source's deadline and returns a failure as a value. A
 * reading the forge confirms unchanged is a current reading.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { isGithubLogin } from "../../shared/forge-logins.ts";
import { isRecord } from "../../shared/guards.ts";
import { ghConditionalGet } from "../../shared/gh-conditional.ts";
import { failedBy, outboundFailure } from "../../shared/outbound/failure.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { PAST_DEADLINE, type Reading } from "./reading.ts";

/** A listing's page size, and the most pages one listing reads. */
const PER_PAGE = 100;
const MAX_PAGES = 30;

/** A pull request as the forge reports it. */
export interface PullDoc {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  head: string;
  /** The pull request's checked-out branch, when the forge names it. */
  headRef?: string;
  /** The branch it merges into. */
  baseRef: string;
  author: string;
  labels: string[];
  /** `MERGEABLE`, `CONFLICTING`, or `UNKNOWN` while the forge computes it. */
  mergeable: string;
  mergedAt: string | null;
}

/** One label event of a pull request's timeline. */
export interface LabelEvent {
  label: string;
  added: boolean;
  actor: string;
  at: string;
}

type Got = Outcome<string, "absent" | "unreadable">;

async function get(reading: Reading, path: string): Promise<Got> {
  const sec = reading.sourceSec();
  if (sec === 0) return failed("unreadable", PAST_DEADLINE);
  reading.forgeCall();
  const r = await ghConditionalGet(path, { timeoutSec: sec });
  if (r.ok) return ok(r.body);
  const code = /HTTP 404\b/.test(r.reason) ? "absent" : "unreadable";
  // The call's failure class travels with the failure, for a reader that names its cause.
  return r.failure === undefined
    ? failed(code, r.reason)
    : failedBy(code, r.failure, r.reason);
}

/** A response body as JSON; `undefined` for one that is not, which each reader then reports as unreadable. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    swallow(error, "a forge response is not JSON");
    return undefined;
  }
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The forge's REST mergeability in the words the drive's classifier reads. */
function mergeability(v: unknown): string {
  if (v === true) return "MERGEABLE";
  if (v === false) return "CONFLICTING";
  return "UNKNOWN";
}

/** A pull request; `absent` when the forge has none of that number. */
export async function readPull(
  reading: Reading,
  repo: string,
  pr: number,
): Promise<Outcome<PullDoc, "absent" | "unreadable">> {
  const got = await get(reading, `repos/${repo}/pulls/${pr}`);
  if (!got.ok) return got;
  const v = json(got.value);
  if (!isRecord(v) || (v.state !== "open" && v.state !== "closed"))
    return failed("unreadable", `pulls/${pr} is not a pull request document`);
  const head = isRecord(v.head) ? text(v.head.sha) : "";
  const labels = Array.isArray(v.labels)
    ? v.labels.flatMap((l) => (isRecord(l) ? [text(l.name)] : []))
    : [];
  return ok({
    number: pr,
    title: text(v.title),
    url: text(v.html_url),
    state:
      v.merged === true ? "MERGED" : v.state === "open" ? "OPEN" : "CLOSED",
    head,
    headRef: isRecord(v.head) ? text(v.head.ref) : "",
    baseRef: isRecord(v.base) ? text(v.base.ref) : "",
    author: isRecord(v.user) ? text(v.user.login) : "",
    labels,
    mergeable: mergeability(v.mergeable),
    mergedAt: typeof v.merged_at === "string" ? v.merged_at : null,
  });
}

/** The commit a branch of the repository is at now; `absent` when it has none. */
export async function readBranchHead(
  reading: Reading,
  repo: string,
  branch: string,
): Promise<Outcome<string, "absent" | "unreadable">> {
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const got = await get(reading, `repos/${repo}/git/ref/heads/${ref}`);
  if (!got.ok) return got;
  const v = json(got.value);
  const sha = isRecord(v) && isRecord(v.object) ? text(v.object.sha) : "";
  return sha === ""
    ? failed("unreadable", `branch ${branch}'s ref names no commit`)
    : ok(sha);
}

/** Every page of a listing, as the forge's objects. */
async function pages(
  reading: Reading,
  path: string,
): Promise<Outcome<unknown[], "absent" | "unreadable">> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await get(
      reading,
      `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`,
    );
    if (!got.ok) return got;
    const items = json(got.value);
    if (!Array.isArray(items))
      return failed("unreadable", `${path} is not a listing`);
    all.push(...items);
    if (items.length < PER_PAGE) return ok(all);
  }
  return failed(
    "unreadable",
    `${path} runs past ${MAX_PAGES * PER_PAGE} entries, more than one answer reads`,
  );
}

/** A pull request's or an issue's comments, earliest first, as the forge's objects. */
export function readComments(
  reading: Reading,
  repo: string,
  number: number,
): Promise<Outcome<unknown[], "absent" | "unreadable">> {
  return pages(reading, `repos/${repo}/issues/${number}/comments`);
}

/** A pull request's or an issue's label events, earliest first. */
export async function readLabelEvents(
  reading: Reading,
  repo: string,
  number: number,
): Promise<Outcome<LabelEvent[], "absent" | "unreadable">> {
  const got = await pages(reading, `repos/${repo}/issues/${number}/timeline`);
  if (!got.ok) return got;
  return ok(
    got.value.flatMap((e): LabelEvent[] => {
      if (!isRecord(e) || (e.event !== "labeled" && e.event !== "unlabeled"))
        return [];
      return [
        {
          label: isRecord(e.label) ? text(e.label.name) : "",
          added: e.event === "labeled",
          actor: isRecord(e.actor) ? text(e.actor.login) : "",
          at: text(e.created_at),
        },
      ];
    }),
  );
}

/**
 * The repository's configuration file as its default branch holds it,
 * which is what the dispatcher's tick reads, never a checkout's copy;
 * `null` when the branch has none.
 */
export async function readDefaultConfig(
  reading: Reading,
  repo: string,
): Promise<Outcome<string | null, "unreadable">> {
  const encoded = OVERLAY_RELPATH.split("/").map(encodeURIComponent).join("/");
  const got = await get(reading, `repos/${repo}/contents/${encoded}`);
  if (!got.ok)
    return got.failure.code === "absent"
      ? ok(null)
      : failed("unreadable", got.failure.reason);
  const v = json(got.value);
  if (!isRecord(v) || v.encoding !== "base64" || typeof v.content !== "string")
    return failed(
      "unreadable",
      `${OVERLAY_RELPATH} on ${repo}'s default branch came back without its content`,
    );
  return ok(Buffer.from(v.content, "base64").toString("utf8"));
}

/**
 * The login the forge client is signed in as; `null` when the forge answered
 * with a user document that names no login, and the read's failure, carrying
 * the call's class, when it was not read: an answer that does not parse, is
 * not a user document or names a malformed login is `invalid`.
 */
export async function readLogin(
  reading: Reading,
): Promise<Outcome<string | null, "absent" | "unreadable">> {
  const got = await get(reading, "user");
  if (!got.ok) return got;
  const unreadable = (what: string) =>
    failedBy(
      "unreadable" as const,
      outboundFailure("invalid", `the forge's user answer ${what}`),
    );
  const v = json(got.value);
  if (!isRecord(v)) return unreadable("is not a user document");
  if (v.login !== undefined && v.login !== null && typeof v.login !== "string")
    return unreadable("names a login that is not text");
  const login = text(v.login);
  if (login === "") return ok(null);
  return isGithubLogin(login, { bot: true })
    ? ok(login)
    : unreadable("names a login that is malformed");
}

/** A forge comment's fields an answer reads. */
export interface CommentFields {
  id: number;
  login: string;
  association: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  body: string;
}

/** A comment object's fields; `null` for one with no id. */
export function commentFields(c: unknown): CommentFields | null {
  if (!isRecord(c) || typeof c.id !== "number") return null;
  return {
    id: c.id,
    login: isRecord(c.user) ? text(c.user.login) : "",
    association: text(c.author_association),
    createdAt: text(c.created_at),
    updatedAt: text(c.updated_at),
    url: text(c.html_url),
    body: text(c.body),
  };
}

/** Open pull requests and their label scope, fully paged within the answer's deadline. */
export async function readOpenPulls(
  reading: Reading,
  repo: string,
): Promise<
  Outcome<
    Array<{ number: number; labels: string[] | null }>,
    "absent" | "unreadable"
  >
> {
  const read = await pages(reading, `repos/${repo}/pulls?state=open`);
  if (!read.ok) return read;
  const numbers = read.value.map((v) => (isRecord(v) ? v.number : undefined));
  if (
    !numbers.every(
      (n): n is number =>
        typeof n === "number" && Number.isSafeInteger(n) && n > 0,
    )
  )
    return failed(
      "unreadable",
      "the open pull request listing has invalid numbers",
    );
  return ok(
    numbers.map((number, i) => {
      const v = read.value[i];
      const labels = isRecord(v) && Array.isArray(v.labels) ? v.labels : null;
      return {
        number,
        labels: labels?.every((l) => isRecord(l) && typeof l.name === "string")
          ? labels.map((l) => (l as { name: string }).name)
          : null,
      };
    }),
  );
}
