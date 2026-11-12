/**
 * The page's own calls to GitHub's REST API, made from this browser with the
 * token the person pasted (`forge-token.ts`): who the token signs in as, and
 * one answer comment on a pull request. The dashboard's server never sees the
 * token or the call; the page's content security policy lets it reach its own
 * server and `api.github.com` alone. Nothing here logs the token or puts it
 * anywhere but the `Authorization` header of a call to GitHub.
 */
import { isRecord } from "../../plugin/shared/guards.ts";
import type { SendTarget } from "./send-target.ts";

export const GITHUB_API = "https://api.github.com";

/** How long a call may take before the page gives up on it. */
const DEADLINE_MS = 20_000;

/** What a call to GitHub answered: its value, or the status (`null` when none came back) and GitHub's own message. */
export type GithubAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | null; message: string };

async function call(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<GithubAnswer<unknown>> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (cause) {
    // A refused connection, a policy that blocks it, or the deadline: no answer came back.
    if (!(cause instanceof TypeError || cause instanceof DOMException))
      throw cause;
    return { ok: false, status: null, message: cause.message };
  }
  let read: unknown = null;
  try {
    read = await response.json();
  } catch (cause) {
    // A body that is not JSON carries no message to show.
    if (!(cause instanceof SyntaxError || cause instanceof TypeError))
      throw cause;
  }
  if (response.ok) return { ok: true, value: read };
  const message =
    isRecord(read) && typeof read.message === "string"
      ? read.message
      : response.statusText;
  return { ok: false, status: response.status, message };
}

/** The login the token signs in as. */
export async function tokenLogin(token: string): Promise<GithubAnswer<string>> {
  const answer = await call(token, "GET", "/user");
  if (!answer.ok) return answer;
  const login = isRecord(answer.value) ? answer.value.login : undefined;
  return typeof login === "string" && login !== ""
    ? { ok: true, value: login }
    : { ok: false, status: 200, message: "GitHub named no login" };
}

/** Posts `body` as a comment on `to`; the comment's link. */
export async function postComment(
  token: string,
  to: SendTarget,
  body: string,
): Promise<GithubAnswer<string>> {
  const [owner, name] = to.repo.split("/");
  const path = `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/issues/${to.number}/comments`;
  const answer = await call(token, "POST", path, { body });
  if (!answer.ok) return answer;
  const url = isRecord(answer.value) ? answer.value.html_url : undefined;
  return {
    ok: true,
    value:
      typeof url === "string" && url.startsWith("https://github.com/")
        ? url
        : `https://github.com/${to.repo}/pull/${to.number}`,
  };
}

/** What a refused token test means, for the settings panel. */
export function tokenRefusal(answer: {
  status: number | null;
  message: string;
}): string {
  if (answer.status === null)
    return `GitHub could not be reached (${answer.message}). Check the connection and test again.`;
  if (answer.status === 401)
    return `GitHub refused the token (401: ${answer.message}): it is mistyped, expired or revoked. Paste a new one.`;
  if (answer.status === 403)
    return `GitHub refused the token (403: ${answer.message}): an organization may not have approved it yet, or a rate limit was hit.`;
  return `GitHub answered ${answer.status}: ${answer.message}.`;
}

/** What a refused Send means, with what to do next. */
export function sendRefusal(
  answer: { status: number | null; message: string },
  to: SendTarget,
): string {
  const where = `${to.repo} #${to.number}`;
  if (answer.status === null)
    return `GitHub could not be reached (${answer.message}). The comment may or may not have been posted: open the pull request and check before sending again.`;
  if (answer.status === 401)
    return `GitHub refused the token (401: ${answer.message}): it is mistyped, expired or revoked. Paste a new one in Send settings; nothing was posted.`;
  if (answer.status === 403)
    return `GitHub refused the comment (403: ${answer.message}). The token may lack read and write access to Issues and Pull requests on ${to.repo}, the organization may not have approved it, or a rate limit was hit; nothing was posted.`;
  if (answer.status === 404)
    return `GitHub found no ${where} for this token (404: ${answer.message}): the token was not granted ${to.repo}, or cannot see it. Grant the repository to the token; nothing was posted.`;
  if (answer.status === 410)
    return `GitHub says ${where} takes no comments (410: ${answer.message}); nothing was posted.`;
  if (answer.status === 422)
    return `GitHub would not take the comment (422: ${answer.message}); nothing was posted.`;
  return `GitHub answered ${answer.status}: ${answer.message}. Open the pull request and check before sending again.`;
}
