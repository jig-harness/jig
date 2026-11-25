/**
 * A pull request URL argument names its forge host and repository as well as
 * the number. The status evaluation reads the pull request from the checkout's
 * own repository, so a URL that names another one is refused rather than read
 * as if its number were this repository's.
 */

/** The host and `owner/name` a pull request URL names, when the argument is one. */
export function pullUrlParts(
  arg: string,
): { host: string; repo: string } | undefined {
  const m = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/\d+/i.exec(arg);
  return m?.[1] === undefined || m[2] === undefined
    ? undefined
    : { host: m[1], repo: m[2] };
}

/** Why the URL's repository is not the checkout's, or null when it is. */
export function pullUrlMismatch(
  url: { host: string; repo: string },
  pr: string,
  checkout: { owner: string; repo: string; url: string | undefined },
): string | null {
  const here = `${checkout.owner}/${checkout.repo}`;
  if (url.repo.toLowerCase() !== here.toLowerCase())
    return `${url.repo}#${pr} is not in this checkout's repository ${here}; run the gate from a checkout of ${url.repo}`;
  let host = "";
  try {
    host = new URL(checkout.url ?? "").host;
  } catch {
    // An unreadable repository URL cannot confirm the host: refuse below.
  }
  return host.toLowerCase() === url.host.toLowerCase()
    ? null
    : `${url.host}/${url.repo} is on another forge host than this checkout's repository ${host || "(unknown)"}/${here}; run the gate from a checkout of it`;
}
