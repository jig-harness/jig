/**
 * What `jig ask` reads on the forge: a pull request, its comments, its
 * timeline and the login the forge client is signed in as. Every read is a
 * conditional request (`shared/gh-conditional.ts`), so a resource that has
 * not changed since the last read on this machine costs nothing against the
 * forge's limit, which every drive on the machine shares; each is counted,
 * runs under its source's deadline and returns a failure as a value. A
 * reading the forge confirms unchanged is a current reading.
 */
import { swallow } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import { ghConditionalGet } from "../../shared/gh-conditional.ts";
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
  return /HTTP 404\b/.test(r.reason)
    ? failed("absent", r.reason)
    : failed("unreadable", r.reason);
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

/** The login the forge client is signed in as; `null` when it cannot say, and every answer then trusts only the authors the forge vouches for. */
export async function readLogin(reading: Reading): Promise<string | null> {
  const got = await get(reading, "user");
  const v = got.ok ? json(got.value) : undefined;
  const login = isRecord(v) ? text(v.login) : "";
  return /^[A-Za-z0-9-]+(\[bot\])?$/.test(login) ? login : null;
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
