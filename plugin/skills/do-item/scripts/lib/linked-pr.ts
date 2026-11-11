/**
 * Whether an item's linked pull request merged, read from the forge (the
 * code host). The parent roll-up needs it only where `pr_open` shares its
 * tracker name with `in_review`: an item waits under that one name while its
 * pull request is open and again after the merge, and only the pull request
 * tells the two apart.
 *
 * An item's pull requests are found two ways: the pull-request links in the
 * item's own comments (the comment `do-item` posts when the pull request
 * opens), and the pull requests whose body carries the item's issue-link
 * line (`Closes <KEY>` or `Refs <KEY>`, alone on a line or in a batch's
 * table cell).
 *
 * A pull request found through a comment counts only when its own body
 * carries the item's issue-link line too, so an incidental URL in a comment
 * is no evidence. On a GitHub tracker whose issues live in another
 * repository than the code, the issue-link line names the issue qualified
 * (`Closes owner/name#5`); a bare `#5` would be the code repository's issue.
 *
 * The reading fails closed: an open pull request wins over a merged one
 * (later work on the same item is still active), a pull request merged into
 * a branch other than the integration branch has not landed, and any read
 * that fails makes the whole answer `unreadable`.
 */

/** What the forge says about an item's linked pull requests. */
export type LinkedPrState = "merged" | "open" | "none" | "unreadable";

export const LINKED_PR_STATES: ReadonlyArray<LinkedPrState> = [
  "merged",
  "open",
  "none",
  "unreadable",
];

/** One pull request as the forge reports it. */
export interface PullFact {
  number: number;
  url: string;
  /** The forge's state: `OPEN`, `MERGED` or `CLOSED`. */
  state: string;
  baseRefName: string;
}

export interface LinkedPr {
  pullRequest: LinkedPrState;
  /** The linked pull requests' addresses, in number order. */
  pulls: string[];
  reason: string;
}

/** The forge reads the lookup makes; each answers `null` when it cannot read. */
export interface LinkedPrReads {
  /** The bodies of the item's comments. */
  comments(key: string): Promise<string[] | null>;
  /** The pull requests whose body mentions `term`, each with its body. */
  search(term: string): Promise<Array<PullFact & { body: string }> | null>;
  /** One pull request by number, with its body. */
  view(number: number): Promise<(PullFact & { body: string }) | null>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The numbers of the pull requests of `repository` (`owner/name`) that `text` links to. */
export function pullNumbersIn(text: string, repository: string): number[] {
  const re = new RegExp(
    `https://github\\.com/${escapeRe(repository)}/pull/([1-9]\\d*)(?!\\d)`,
    "gi",
  );
  return [...text.matchAll(re)].map((m) => Number(m[1]));
}

/**
 * Whether `body` carries the issue-link line for `key`: `Closes <KEY>` or
 * `Refs <KEY>`, at the start of a line or of a table cell. `keySource` is
 * the tracker's key pattern (`IssueKeys.source`), which keeps `ENG-12` from
 * matching inside `ENG-123`.
 */
export function linksIssue(
  body: string,
  key: string,
  keySource: string,
): boolean {
  const re = new RegExp(
    `(?:^|\\|)[ \\t]*(?:closes|refs)[ \\t]+(${keySource})`,
    "gim",
  );
  return [...body.matchAll(re)].some(
    (m) => m[1]?.toUpperCase() === key.toUpperCase(),
  );
}

/**
 * The reading of an item's linked pull requests: `open` while any is open,
 * else `merged` when one merged into `trunk`, else `none`. A pull request
 * merged into another branch (a stacked layer) has not landed and reads as
 * `open`.
 */
export function linkedPrState(
  pulls: ReadonlyArray<PullFact>,
  trunk: string,
): Exclude<LinkedPrState, "unreadable"> {
  const state = (p: PullFact) => p.state.toUpperCase();
  if (
    pulls.some(
      (p) =>
        state(p) === "OPEN" ||
        (state(p) === "MERGED" && p.baseRefName !== trunk),
    )
  )
    return "open";
  return pulls.some((p) => state(p) === "MERGED") ? "merged" : "none";
}

/**
 * The key as an issue-link line names it: qualified (`owner/name#5`) when a
 * GitHub tracker's issues live in another repository than the code's, since
 * a bare `#5` would be the code repository's own issue; otherwise as given.
 */
export function linkLineKey(
  key: string,
  trackerRepository: string | undefined,
  repository: string,
): string {
  return trackerRepository !== undefined &&
    /^#[1-9]\d*$/.test(key) &&
    trackerRepository.toLowerCase() !== repository.toLowerCase()
    ? `${trackerRepository}${key}`
    : key;
}

function unreadable(reason: string): LinkedPr {
  return { pullRequest: "unreadable", pulls: [], reason };
}

/**
 * Read one item's linked pull requests and reduce them to a `LinkedPr`.
 * `searchTerm` is the key as the forge's search finds it (a GitHub number
 * without its `#`).
 */
export async function readLinkedPr(
  key: string,
  opts: {
    reads: LinkedPrReads;
    repository: string;
    keySource: string;
    trunk: string;
    /** The tracker's `owner/name` on a GitHub tracker. */
    trackerRepository?: string | undefined;
    /**
     * Whether a pull request found through a comment must link the item in
     * its own body. False where `pull_requests.issue_link` is `none`: the
     * pull request then carries no link line, and the item's comment is the
     * only record of it.
     */
    bodyLinkRequired?: boolean;
  },
): Promise<LinkedPr> {
  const { reads, repository, trunk, trackerRepository } = opts;
  const bodyLinkRequired = opts.bodyLinkRequired ?? true;
  const linkKey = linkLineKey(key, trackerRepository, repository);
  const keySource =
    linkKey === key
      ? opts.keySource
      : `${escapeRe(linkKey.slice(0, linkKey.lastIndexOf("#")))}#[1-9]\\d*(?!\\w)`;
  const comments = await reads.comments(key);
  if (comments === null)
    return unreadable(`the comments of ${key} could not be read`);
  const searched = await reads.search(key.replace(/^#/, ""));
  if (searched === null)
    return unreadable(`the pull requests naming ${key} could not be searched`);
  const pulls = new Map<number, PullFact>();
  for (const p of searched)
    if (linksIssue(p.body, linkKey, keySource)) pulls.set(p.number, p);
  for (const n of new Set(
    comments.flatMap((c) => pullNumbersIn(c, repository)),
  )) {
    if (pulls.has(n)) continue;
    const viewed = await reads.view(n);
    if (viewed === null)
      return unreadable(
        `pull request #${n}, linked from ${key}, could not be read`,
      );
    if (!bodyLinkRequired || linksIssue(viewed.body, linkKey, keySource))
      pulls.set(n, viewed);
  }
  const facts = [...pulls.values()].sort((a, b) => a.number - b.number);
  const pullRequest = linkedPrState(facts, trunk);
  const reason =
    pullRequest === "none"
      ? facts.length === 0
        ? `${key} has no linked pull request`
        : `no linked pull request of ${key} is open or merged into ${trunk}`
      : pullRequest === "merged"
        ? `a linked pull request of ${key} merged into ${trunk}`
        : `a linked pull request of ${key} is open or not yet landed on ${trunk}`;
  return { pullRequest, pulls: facts.map((p) => p.url), reason };
}
