// The link destinations a Markdown file declares, read by a CommonMark
// renderer: Bun's own (`Bun.markdown`), so code spans, fences, escapes,
// containers, multi-line destinations and reference definitions are parsed as
// a renderer parses them rather than approximated. A link or image declares
// its destination; a reference link declares its definition's, and a
// definition nothing uses renders nothing, so declares nothing. Raw HTML is
// not read.

/** One destination and the 1-based line it starts on. */
export interface MarkdownLink {
  target: string;
  line: number;
}

/** Every link destination `content` declares, ordered by line. */
export function markdownLinks(content: string): MarkdownLink[] {
  const raw: string[] = [];
  const collect = (children: string, href: string) => {
    raw.push(href);
    return children;
  };
  Bun.markdown.render(content, {
    link: (children, { href }) => collect(children, href),
    image: (children, { src }) => collect(children, src),
  });
  let cursor = 0;
  const links = raw.map((href) => {
    const at = sourceIndex(content, href, cursor);
    if (at.advance) cursor = at.index + href.length;
    return {
      target: autolinkedEmail(content, href)
        ? `mailto:${href}`
        : unescapeDestination(href),
      line: content.slice(0, at.index).split("\n").length,
    };
  });
  return links.sort((a, b) => a.line - b.line);
}

/**
 * Where `href`, as the renderer reported it (its source text), is written. An
 * inline link's destination follows its own `(` after the previous link's; a
 * reference link's is at its definition, earlier or later in the file, and
 * moves nothing on. The line is the destination's, so it can name a line where
 * the same text stood in prose before the link.
 */
function sourceIndex(
  content: string,
  href: string,
  cursor: number,
): { index: number; advance: boolean } {
  const text = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`(?:\\(|\\]:)\\s*<?${text}`, "g");
  opener.lastIndex = cursor;
  const inline = opener.exec(content);
  if (inline !== null && content[inline.index] === "(")
    return {
      index: inline.index + inline[0].length - href.length,
      advance: true,
    };
  opener.lastIndex = 0;
  const anywhere = opener.exec(content) ?? inline;
  const index = anywhere
    ? anywhere.index + anywhere[0].length - href.length
    : Math.max(content.indexOf(href), 0);
  return { index, advance: false };
}

/** Whether `href` is an email autolink (`<a@b.c>`), which renders as mailto. */
function autolinkedEmail(content: string, href: string): boolean {
  return (
    /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i.test(
      href,
    ) && content.includes(`<${href}>`)
  );
}

/**
 * A destination as the renderer's source text holds it, with its backslash
 * escapes removed and its character references decoded, left to right, so an
 * escaped `&` starts no reference.
 */
function unescapeDestination(target: string): string {
  return target.replace(
    /\\([!-/:-@[-`{-~])|&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g,
    (whole, escaped: string | undefined) =>
      escaped ?? characterReference(whole),
  );
}

/** The text one character reference stands for; an unknown one as written. */
function characterReference(reference: string): string {
  const html = Bun.markdown.html(reference).trim();
  return html
    .replace(/^<p>|<\/p>$/g, "")
    .replace(
      /&(lt|gt|quot|amp);/g,
      (_, name: string) =>
        ({ lt: "<", gt: ">", quot: '"', amp: "&" })[name] ?? "",
    );
}

/** A destination's percent-encoding decoded, or the destination as written. */
export function decode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}
