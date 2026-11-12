/**
 * Where a card's Send posts, or why a card has no Send. Send writes the
 * comment Copy takes as a comment on the pull request, and only a drive
 * reads an answer from one: its re-arm reads the `answer <key>:` lines on
 * its pull request. So Send is offered for a parked drive's decisions alone,
 * and only on GitHub's own site, the one forge whose API the page's content
 * security policy lets it reach.
 */

/** The pull request a card's answers are posted on. */
export interface SendTarget {
  /** `owner/name`. */
  repo: string;
  number: number;
}

/** A card's link to its pull request on GitHub, by repository and number. */
const GITHUB_PULL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** What a card of `need` sends to, or why it has no Send, in words for the card. */
export function sendTargetOf(need: {
  repo: string;
  pr: number | null;
  url: string | null;
  /** Whether the card holds a drive's parked decisions. */
  parked: boolean;
}): { to: SendTarget } | { absent: string } {
  if (!need.parked || need.pr === null)
    return {
      absent:
        "No Send here: only a drive's parked decisions are read from an answer comment. Settle this one where its link goes.",
    };
  if (need.url === null)
    return {
      absent:
        "No Send here: the record holds no link to this pull request, so the page cannot tell which forge it is on. Copy the answers and paste them.",
    };
  const found = GITHUB_PULL.exec(need.url);
  if (found === null)
    return {
      absent: `No Send here: Send posts to github.com only, and this pull request is at ${hostOf(need.url)}. Copy the answers and paste them.`,
    };
  if (
    found[1]?.toLowerCase() !== need.repo.toLowerCase() ||
    Number(found[2]) !== need.pr
  )
    return {
      absent: `No Send here: the record's link names another pull request than ${need.repo} #${need.pr}. Copy the answers and paste them.`,
    };
  return { to: { repo: need.repo, number: need.pr } };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch (cause) {
    // A link the page cannot parse names no host it can show.
    if (!(cause instanceof TypeError)) throw cause;
    return "another address";
  }
}
