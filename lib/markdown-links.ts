// The link destinations a Markdown file declares, read by a CommonMark
// renderer: Bun's own (`Bun.markdown`), so code spans, fences, escapes,
// containers, multi-line destinations and reference definitions are parsed as
// a renderer parses them rather than approximated. A link or image declares
// its destination; a reference link declares its definition's, and a
// definition nothing uses renders nothing, so declares nothing. Raw HTML is
// not read.
//
// The renderer reports no source positions, so where a destination stands, and
// whether a link is an email autolink, is asked of the renderer too: change
// one place in the source and render again. The place that changes the link
// is where the link is written; text that only repeats it (in code, prose or
// an unused definition) changes nothing.

/** One destination and the 1-based line it starts on. */
export interface MarkdownLink {
  target: string;
  line: number;
}

/** A destination as the renderer reports it: its source text. */
interface Rendered {
  href: string;
  image: boolean;
}

/** Every link destination `content` declares, ordered by line. */
export function markdownLinks(content: string): MarkdownLink[] {
  const rendered = render(content);
  const at = sourceIndexes(content, rendered);
  const links = rendered.map(({ href, image }, i) => {
    const index = at[i] ?? 0;
    return {
      target:
        !image && emailAutolink(content, href, index, rendered.length)
          ? `mailto:${href}`
          : unescapeDestination(href),
      line: content.slice(0, index).split("\n").length,
    };
  });
  return links.sort((a, b) => a.line - b.line);
}

function render(content: string): Rendered[] {
  const rendered: Rendered[] = [];
  Bun.markdown.render(content, {
    link: (children, { href }) => {
      rendered.push({ href, image: false });
      return children;
    },
    image: (children, { src }) => {
      rendered.push({ href: src, image: true });
      return children;
    },
  });
  return rendered;
}

/**
 * Where each destination's source text starts: the occurrence of that text
 * whose change changes this destination. A reference link's is its
 * definition's. Text with one occurrence needs no asking; text with no letter
 * or digit to change falls back to its first occurrence.
 */
function sourceIndexes(content: string, rendered: Rendered[]): number[] {
  const at = rendered.map(() => -1);
  for (const href of new Set(rendered.map((link) => link.href))) {
    const occurrences = indexesOf(content, href);
    const change = href.search(/[a-z\d]/i);
    const asked = occurrences.length > 1 && change !== -1 ? occurrences : [];
    for (const index of asked)
      for (const i of changedLinks(content, rendered, href, index + change))
        if (at[i] === -1) at[i] = index;
    rendered.forEach((link, i) => {
      if (link.href === href && at[i] === -1) at[i] = occurrences[0] ?? 0;
    });
  }
  return at;
}

/** The links to `href` that change when the character at `index` does. */
function changedLinks(
  content: string,
  rendered: Rendered[],
  href: string,
  index: number,
): number[] {
  const changed = render(replaceAt(content, index));
  if (changed.length !== rendered.length) return [];
  return rendered.flatMap((link, i) =>
    link.href === href && changed[i]?.href !== href ? [i] : [],
  );
}

function indexesOf(content: string, text: string): number[] {
  const found: number[] = [];
  for (
    let index = content.indexOf(text);
    index !== -1 && text !== "";
    index = content.indexOf(text, index + 1)
  )
    found.push(index);
  return found;
}

/** `content` with the letter or digit at `index` changed to another. */
function replaceAt(content: string, index: number): string {
  const char = content[index] ?? "";
  const other = /\d/.test(char)
    ? String((Number(char) + 1) % 10)
    : /[zZ]/.test(char)
      ? String.fromCharCode(char.charCodeAt(0) - 25)
      : String.fromCharCode(char.charCodeAt(0) + 1);
  return content.slice(0, index) + other + content.slice(index + 1);
}

/**
 * Whether the link to `href`, written at `at`, is an email autolink
 * (`<a@b.c>`), which renders as mailto: its `<` is the autolink's own when the
 * link is gone without it. In `[x](<a@b.c>)` or a definition the `<` only
 * brackets a destination, which stays a link.
 */
function emailAutolink(
  content: string,
  href: string,
  at: number,
  count: number,
): boolean {
  if (
    !/^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i.test(
      href,
    ) ||
    content[at - 1] !== "<" ||
    content[at + href.length] !== ">"
  )
    return false;
  const without = `${content.slice(0, at - 1)} ${content.slice(at)}`;
  return render(without).length < count;
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
