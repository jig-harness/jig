// Serves the built site to every reader: a page, the file asked for, or a
// page's Markdown twin for a reader that prefers Markdown.

import { twinPath, twinResponse, wantsMarkdown } from "./markdown.ts";

interface Env {
  /** The built site, bound as static assets in wrangler.jsonc. */
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
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
