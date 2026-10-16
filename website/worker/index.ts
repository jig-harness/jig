// The site is private until it opens to the public: a reader gets in with a
// link that carries the key, and stays in through a cookie the link sets.
// Nothing is served without the key, and nothing at all when no key is set.

import { twinPath, twinResponse, wantsMarkdown } from "./markdown.ts";

interface Env {
  /** The built site, bound as static assets in wrangler.jsonc. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The secret the link carries; set with `wrangler secret put SITE_KEY`. */
  SITE_KEY?: string;
}

const KEY_PARAM = "key";
const COOKIE = "jig_site";
/** How long a reader stays in after opening the link once. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
/** Served to everyone, so crawlers that ask are told to stay out. */
const ROBOTS = "/robots.txt";

const PRIVATE_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Jig</title>
<p style="font:1.1rem/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem">
This site is private for now. Open it with the link you were sent.
</p>
</html>
`;

/** The cookie holds the key's digest, not the key: changing the key ends every visit. */
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Compares two digests in time that does not depend on where they differ. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function privatePage(): Response {
  return new Response(PRIVATE_PAGE, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === ROBOTS) return env.ASSETS.fetch(request);
    if (!env.SITE_KEY) return privatePage();
    const expected = await digest(env.SITE_KEY);

    // The link: check its key, set the cookie, and send the reader on to
    // the same page without the key, so it stays out of history and
    // address bars. The redirect is absolute, so a path such as
    // `//other.example/` stays on this site instead of naming another host.
    const offered = url.searchParams.get(KEY_PARAM);
    if (offered !== null) {
      if (!sameDigest(await digest(offered), expected)) return privatePage();
      url.searchParams.delete(KEY_PARAM);
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.href,
          "Set-Cookie": `${COOKIE}=${expected}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }

    const held = cookieValue(request, COOKIE);
    if (held === undefined || !sameDigest(held, expected)) return privatePage();
    return page(request, env);
  },
};

/**
 * A page, or the file asked for. A reader that prefers Markdown gets a
 * page's twin; every page response says it depends on `Accept`, so a cache
 * keeps the two apart. A twin is served the same way whether it was asked
 * for by its address or by `Accept`.
 */
async function page(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const twin = twinPath(url.pathname);
  if (twin === null) {
    if (!url.pathname.endsWith(".md")) return env.ASSETS.fetch(request);
    return (await markdown(url, request, env)) ?? env.ASSETS.fetch(request);
  }
  if (wantsMarkdown(request.headers.get("Accept"))) {
    const found = await markdown(new URL(twin, url), request, env);
    if (found) return found;
  }
  const html = await env.ASSETS.fetch(request);
  const headers = new Headers(html.headers);
  headers.append("Vary", "Accept");
  return new Response(html.body, {
    status: html.status,
    statusText: html.statusText,
    headers,
  });
}

/**
 * The twin at `url` as a Markdown response, or null when there is none. The
 * twin is read whole, with a plain GET whatever the request's method and
 * conditions: its headers (the token estimate above all) describe the whole
 * twin, so a HEAD or a conditional request gets the same answer a GET does,
 * and a missing twin is the only case that falls back to HTML.
 */
async function markdown(
  url: URL,
  request: Request,
  env: Env,
): Promise<Response | null> {
  const found = await env.ASSETS.fetch(new Request(url));
  if (found.status !== 200) return null;
  return twinResponse(found, await found.text(), request.method === "HEAD");
}
