/**
 * Send follows the station's declared comment target, or a parked drive's
 * pull request. The link must match that target on github.com; a tracker
 * whose station cannot read comment answers keeps Copy alone.
 */

/** The pull request or GitHub issue a card's answers are posted on. */
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
  answerOn?: "pull-request" | "issue" | "tracker";
  answerRepository?: string;
  target?: string;
}): { to: SendTarget } | { absent: string } {
  if (
    !need.parked &&
    need.answerOn !== "pull-request" &&
    need.answerOn !== "issue"
  )
    return {
      absent:
        "No Send here: this station cannot read an answer comment here. Settle this one where its link goes.",
    };
  const kind = need.answerOn === "issue" ? "issue" : "pull request";
  const repo =
    need.answerOn === "issue"
      ? (need.answerRepository ?? need.repo)
      : need.repo;
  if (need.url === null)
    return {
      absent: `No Send here: the record holds no link to this ${kind}, so the page cannot tell which forge it is on. Copy the answers and paste them.`,
    };
  const pattern =
    need.answerOn === "issue"
      ? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)$/
      : GITHUB_PULL;
  const found = pattern.exec(need.url);
  const number =
    need.answerOn === "issue"
      ? Number(/^#(\d+)$/.exec(need.target ?? "")?.[1])
      : need.pr;
  if (found === null)
    return {
      absent: `No Send here: Send posts to github.com only, and this ${kind} is at ${hostOf(need.url)}. Copy the answers and paste them.`,
    };
  if (
    found[1]?.toLowerCase() !== repo.toLowerCase() ||
    Number(found[2]) !== number ||
    !Number.isSafeInteger(number) ||
    (number ?? 0) <= 0
  )
    return {
      absent: `No Send here: the record's link names another ${kind} than ${repo} ${need.target ?? `#${need.pr}`}. Copy the answers and paste them.`,
    };
  return { to: { repo, number: number as number } };
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

/** Whether `hostname` is this machine's loopback: `localhost`, 127.0.0.0/8 or `::1`. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)
  );
}

/**
 * Why the page cannot send from the address it was served at, or `null` when
 * it can. The token a page keeps is as safe as the path the page came over,
 * so Send is offered only over HTTPS or from this machine's loopback; on any
 * other plain-HTTP address someone on the path who can change the page could
 * read the token. A hostname proves no encrypted path, so none is trusted.
 */
export function transportFault(at: {
  protocol: string;
  hostname: string;
}): string | null {
  if (at.protocol === "https:" || isLoopback(at.hostname)) return null;
  return `No Send on this address: the page came over plain HTTP from ${at.hostname}, so someone on the network path could read the token. Open the dashboard over HTTPS or from this machine's loopback to send; Copy works here.`;
}
