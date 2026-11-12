/**
 * Where a card's Send posts, or why a card has no Send. Send writes the
 * comment Copy takes as a comment on the pull request, and only a drive
 * reads an answer from one: its re-arm reads the `answer <key>:` lines on
 * its pull request. So Send is offered for a parked drive's decisions alone,
 * and only on GitHub's own site, the one forge whose API the page's content
 * security policy lets it reach; and only on a page that came over a path
 * that protects the token (`transportFault`).
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

/** Whether `hostname` is this machine's loopback: `localhost`, 127.0.0.0/8 or `::1`. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)
  );
}

/** Whether `hostname` is a Tailscale address: 100.64.0.0/10 or a `*.ts.net` name. */
function isTailscale(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.endsWith(".ts.net")) return true;
  const octets = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets === null) return false;
  const [second, third, fourth] = octets.slice(1).map(Number);
  return (
    second !== undefined &&
    second >= 64 &&
    second <= 127 &&
    [third, fourth].every((n) => n !== undefined && n <= 255)
  );
}

/**
 * Why the page cannot send from the address it was served at, or `null` when
 * it can. The token a page keeps is as safe as the path the page came over,
 * so Send is offered only over HTTPS, from this machine's loopback, or over
 * Tailscale's encrypted network; on any other plain-HTTP address someone on
 * the path who can change the page could read the token.
 */
export function transportFault(at: {
  protocol: string;
  hostname: string;
}): string | null {
  if (
    at.protocol === "https:" ||
    isLoopback(at.hostname) ||
    isTailscale(at.hostname)
  )
    return null;
  return `No Send on this address: the page came over plain HTTP from ${at.hostname}, so someone on the network path could read the token. Open the dashboard over HTTPS, from this machine's loopback or over Tailscale to send; Copy works here.`;
}
