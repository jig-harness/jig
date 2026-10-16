// Markdown for agents: a page's Markdown twin (built by
// scripts/markdown-twins.ts, next to the page as `index.md`) is what a reader
// gets when it asks for `text/markdown` and prefers it to HTML.

/** What the site's owner allows done with its content once it is open. */
const CONTENT_SIGNAL = "ai-train=yes, search=yes, ai-input=yes";

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";

/** The quality an `Accept` header gives one media type, or undefined when it does not name it. */
function quality(
  accept: string,
  type: string,
): { q: number; at: number } | undefined {
  const entries = accept.split(",").map((e) => e.trim().split(";"));
  const at = entries.findIndex(([t]) => t?.trim().toLowerCase() === type);
  if (at < 0) return undefined;
  const param = entries[at]?.slice(1).find((p) => p.trim().startsWith("q="));
  const q = param ? Number.parseFloat(param.trim().slice(2)) : 1;
  return { q: Number.isNaN(q) ? 1 : q, at };
}

/**
 * Whether the header names `text/markdown` and prefers it to `text/html`:
 * a higher quality wins, and at equal quality the one listed first. A
 * wildcard does not ask for Markdown, so a browser or `*\/*` gets HTML.
 */
export function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const md = quality(accept, "text/markdown");
  if (!md || md.q <= 0) return false;
  const html = quality(accept, "text/html");
  return !html || md.q > html.q || (md.q === html.q && md.at < html.at);
}

/** The twin of the page at `pathname`, or null for a path that names a file. */
export function twinPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "");
  if (/\.[^/]+$/.test(path)) return null;
  return `${path}/index.md`;
}

/** An estimate of the tokens in a text, for a reader sizing its context. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** The response that carries a twin. */
export function twinResponse(
  twin: Response,
  text: string,
  head: boolean,
): Response {
  const headers = new Headers(twin.headers);
  headers.set("Content-Type", MARKDOWN_TYPE);
  headers.set("Content-Signal", CONTENT_SIGNAL);
  headers.set("X-Markdown-Tokens", String(estimateTokens(text)));
  headers.append("Vary", "Accept");
  headers.delete("Content-Length");
  return new Response(head ? null : text, { status: twin.status, headers });
}
