/**
 * The forge read behind trusted automation (`trusted-automation.ts`): a
 * listed bot's pull request's commits and files, pinned to its head and base.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { currentMs } from "../../../../shared/time.ts";
import { ghApiJson } from "./merge-facts.ts";
import {
  authorSatisfied,
  type ForgeFacts,
  type ReadyRules,
} from "./merge-ready.ts";
import {
  type AutomationFacts,
  LISTING_PAGE,
  checkCommitPage,
  checkFilePage,
  parseListings,
  trustedEntryFor,
} from "./trusted-automation.ts";

/**
 * A pull request's commits and files at `head`, from the forge's listings of
 * the pull request itself, so they describe the pull request's own diff and
 * commits and not a comparison the forge may compute from another merge
 * base. The commit listing ends at the head, which pins what it read; a
 * listing that fills its page does not read whole. With `slug` `null` the
 * repository is the one the forge client's own view of the working directory
 * names.
 */
type BoundedGet = (
  path: string,
  label: string,
) => Promise<Outcome<unknown, "unreadable">>;

function validateReadInput(
  number: number,
  head: string,
  baseOid: string,
): Outcome<void, "unreadable"> {
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(baseOid))
    return failed("unreadable", "the head or the base is not a commit id");
  if (!Number.isSafeInteger(number) || number <= 0)
    return failed(
      "unreadable",
      "the pull request's number does not pass its form",
    );
  return ok(undefined);
}

/** One deadline covers every request: each gets what is left, and none starts after it or `ended()`. */
function boundedGet(
  slug: string | null,
  deadline: number,
  ended: () => boolean,
): BoundedGet {
  return (path, label) => {
    const left = Math.floor((deadline - currentMs()) / 1000);
    if (ended())
      return Promise.resolve(
        failed<"unreadable">(
          "unreadable",
          `the enclosing bound ended before ${label}`,
        ),
      );
    return left <= 0
      ? Promise.resolve(
          failed<"unreadable">(
            "unreadable",
            `the read's deadline ended before ${label}`,
          ),
        )
      : ghApiJson([path], slug, left, label, label);
  };
}

async function readPinnedPull(
  get: BoundedGet,
  repo: string,
  number: number,
  head: string,
  baseOid: string,
): Promise<Outcome<Record<string, unknown>, "unreadable">> {
  const read = await get(`repos/${repo}/pulls/${number}`, "pull request");
  if (!read.ok) return read;
  const pull = isRecord(read.value) ? read.value : {};
  const headSha = isRecord(pull.head) ? pull.head.sha : undefined;
  const baseSha = isRecord(pull.base) ? pull.base.sha : undefined;
  if (headSha !== head || baseSha !== baseOid)
    return failed(
      "unreadable",
      "the pull request's head or base moved while its commits and files were read",
    );
  return ok(pull);
}

/** A count no listing page can match refuses before any listing is requested. */
function checkListingBounds(
  pull: Record<string, unknown>,
): Outcome<void, "unreadable"> {
  for (const [count, what] of [
    [pull.changed_files, "files"],
    [pull.commits, "commits"],
  ] as const)
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count >= LISTING_PAGE
    )
      return failed(
        "unreadable",
        `the pull request's ${what} count is not one a single listing page holds`,
      );
  return ok(undefined);
}

async function readCheckedFiles(
  get: BoundedGet,
  repo: string,
  number: number,
  expectedCount: unknown,
): Promise<Outcome<{ value: unknown; count: number }, "unreadable">> {
  const files = await get(
    `repos/${repo}/pulls/${number}/files?per_page=${LISTING_PAGE}`,
    "pull request files",
  );
  if (!files.ok) return files;
  const filesOk = checkFilePage(files.value);
  if (!filesOk.ok) return filesOk;
  if (expectedCount !== filesOk.value)
    return failed(
      "unreadable",
      "the file listing does not match the pull request's count at the start",
    );
  return ok({ value: files.value, count: filesOk.value });
}

async function readCheckedCommits(
  get: BoundedGet,
  repo: string,
  number: number,
  head: string,
  expectedCount: unknown,
): Promise<Outcome<{ value: unknown; count: number }, "unreadable">> {
  const commits = await get(
    `repos/${repo}/pulls/${number}/commits?per_page=${LISTING_PAGE}`,
    "pull request commits",
  );
  if (!commits.ok) return commits;
  const commitsOk = checkCommitPage(commits.value, head);
  if (!commitsOk.ok) return commitsOk;
  if (expectedCount !== commitsOk.value)
    return failed(
      "unreadable",
      "the commit listing does not match the pull request's count at the start",
    );
  return ok({ value: commits.value, count: commitsOk.value });
}

function checkSnapshotCounts(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  filesCount: number,
  commitsCount: number,
): Outcome<void, "unreadable"> {
  for (const [pull, label] of [
    [before, "before"],
    [after, "after"],
  ] as const)
    if (pull.changed_files !== filesCount || pull.commits !== commitsCount)
      return failed(
        "unreadable",
        `the listings do not match the pull request's counts ${label} they were read`,
      );
  return ok(undefined);
}

export async function readAutomationFacts(
  slug: string | null,
  number: number,
  head: string,
  baseOid: string,
  timeoutSec: number,
  ended: () => boolean = () => false,
): Promise<Outcome<AutomationFacts, "unreadable">> {
  const valid = validateReadInput(number, head, baseOid);
  if (!valid.ok) return valid;
  const repo = slug ?? "{owner}/{repo}";
  const get = boundedGet(slug, currentMs() + timeoutSec * 1000, ended);
  // The pull request's head and base are confirmed before and after the
  // listings, and its counts must match what the listings hold, so a listing
  // from another revision or a partial one does not pass.
  const before = await readPinnedPull(get, repo, number, head, baseOid);
  if (!before.ok) return before;
  const bounded = checkListingBounds(before.value);
  if (!bounded.ok) return bounded;
  // Each page is held to the first snapshot as it arrives, so a mismatch
  // refuses without the requests that cannot change the answer.
  const files = await readCheckedFiles(
    get,
    repo,
    number,
    before.value.changed_files,
  );
  if (!files.ok) return files;
  const commits = await readCheckedCommits(
    get,
    repo,
    number,
    head,
    before.value.commits,
  );
  if (!commits.ok) return commits;
  const after = await readPinnedPull(get, repo, number, head, baseOid);
  if (!after.ok) return after;
  const matched = checkSnapshotCounts(
    before.value,
    after.value,
    files.value.count,
    commits.value.count,
  );
  if (!matched.ok) return matched;
  return parseListings(commits.value.value, files.value.value, head);
}

/** The key prefix of a kept read; the repository's slug and the pull request's number follow. */
export const AUTOMATION_CACHE_PREFIX = "forge:trusted-automation:";

/** Where a caller keeps a read for the next one: the tick's reads between ticks. */
export interface AutomationCache {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

/** A kept read: the head and the base commit it was read at, and what it read. */
interface Kept {
  head: string;
  baseOid: string;
  facts: AutomationFacts;
}

function keptOf(value: unknown, head: string, baseOid: string): Kept | null {
  if (!isRecord(value) || value.head !== head || value.baseOid !== baseOid)
    return null;
  const facts = value.facts;
  if (
    !isRecord(facts) ||
    facts.head !== head ||
    !Array.isArray(facts.commits) ||
    !Array.isArray(facts.files)
  )
    return null;
  return value as unknown as Kept;
}

/**
 * Whether the Ready predicate needs a pull request's commits and files: its
 * author is a bot the list names, and its head is known to be in the
 * repository (a fork, or a head not known to be in the repository, already
 * fails the rule), and condition 8 does not already hold through an own
 * author association or a qualifying approval.
 */
export function needsAutomation(facts: ForgeFacts, rules: ReadyRules): boolean {
  const list = rules.trustedAutomation;
  return (
    // With no reviewer app a person's approval is the review witness, so the
    // exception cannot change the lane and the reads are not made.
    rules.reviewerApp !== null &&
    list?.ok === true &&
    trustedEntryFor(facts.author, list.value) !== null &&
    facts.crossRepository === false &&
    !authorSatisfied(facts)
  );
}

/**
 * The commits and files the Ready predicate needs for a pull request by a
 * listed bot, read at its head; `undefined` when it needs none
 * (`needsAutomation`). A head's commits and files never change, so a read
 * kept in `cache` for the same head and base commit is reused.
 */
export async function automationFor(
  slug: string | null,
  facts: ForgeFacts,
  rules: ReadyRules,
  timeoutSec: number,
  cache?: AutomationCache,
  ended?: () => boolean,
): Promise<Outcome<AutomationFacts, "unreadable"> | undefined> {
  if (!needsAutomation(facts, rules)) return undefined;
  const baseOid = facts.baseOid ?? "";
  if (!/^[0-9a-f]{40}$/.test(baseOid))
    return failed("unreadable", "its base commit was not read");
  // With no slug the repository is the working directory's: one per process.
  const key = `${AUTOMATION_CACHE_PREFIX}${slug ?? "."}:${facts.number}`;
  const kept =
    cache === undefined
      ? null
      : keptOf(cache.get<unknown>(key), facts.head, baseOid);
  if (kept !== null) return ok(kept.facts);
  const read = await readAutomationFacts(
    slug,
    facts.number,
    facts.head,
    baseOid,
    timeoutSec,
    ended,
  );
  // A read that finished after the enclosing bound ended is not kept.
  if (read.ok && cache !== undefined && ended?.() !== true)
    cache.set(key, {
      head: facts.head,
      baseOid,
      facts: read.value,
    } satisfies Kept);
  return read;
}
