// A Markdown document as it renders, read through Bun's own CommonMark parser
// (`Bun.markdown`) rather than by matching its source: which blocks it holds,
// which headings and list items, and in each the text, links and code it
// shows. A link here is one that renders, its destination resolved by the
// parser: a reference link whose label has no definition renders as its
// literal text, and a definition inside an HTML block, a code block or a
// paragraph is no definition. Shared by the lint's reader (lint-structure.ts)
// and its format rules.

/** What a stretch of inline Markdown renders as. */
export type Inline =
  /** Text; `styled` when it renders emphasized, strong or struck through. */
  | { k: "text"; v: string; styled?: true }
  | { k: "link"; href: string; inline: Inline[] }
  /**
   * A code span, an image or raw inline HTML: neither text nor a link. Code
   * and images are shown; HTML (`html`), a comment above all, may show nothing.
   */
  | { k: "other"; html?: true };

/** A block of the document. */
export type Block =
  | { k: "heading"; level: number; inline: Inline[] }
  | { k: "paragraph"; inline: Inline[] }
  | { k: "list"; ordered: boolean; items: Block[][] }
  | { k: "quote"; blocks: Block[] }
  /** A code block, an HTML block, a thematic break or a table. */
  | { k: "other"; kind: "code" | "html" | "hr" | "table" };

type Item = { k: "item"; blocks: Block[] };
type Node = Inline | Block | Item;

/**
 * Raw inline HTML: the parser hands it to the text callback as a piece of its
 * own, whole, where a literal `<` (escaped, or an entity) arrives as a piece
 * that is only that character or one that does not end the tag.
 */
const HTML_SPAN = /^<[A-Za-z/!?][\s\S]*>$/;

const isInline = (n: Node): n is Inline =>
  n.k === "text" || n.k === "link" || (n.k === "other" && !("kind" in n));
const isItem = (n: Node): n is Item => n.k === "item";
const isBlock = (n: Node): n is Block => !isInline(n) && !isItem(n);

/**
 * A list item's blocks. A tight item's text arrives without a paragraph
 * around it; each run of it is read as the paragraph it renders like.
 */
function itemBlocks(children: Node[]): Block[] {
  const blocks: Block[] = [];
  let run: Inline[] | null = null;
  for (const child of children) {
    if (isItem(child)) continue;
    if (!isInline(child)) {
      blocks.push(child);
      run = null;
    } else if (run) run.push(child);
    else {
      run = [child];
      blocks.push({ k: "paragraph", inline: run });
    }
  }
  return blocks;
}

/**
 * The callbacks that build one document's nodes. Each callback keeps its node
 * in `table` and returns only the node's number in brackets, so the
 * children a parent receives are those numbers and nothing else: no text of
 * the document is ever in them to be read as structure.
 */
function callbacks(table: Node[]) {
  const node = (n: Node): string => `[${table.push(n) - 1}]`;
  const nodes = (children: string): Node[] =>
    [...children.matchAll(/\[(\d+)\]/g)].flatMap((m) => {
      const n = table[Number(m[1])];
      return n ? [n] : [];
    });
  const inline = (c: string) => nodes(c).filter(isInline);
  const styled = (c: string): string => {
    for (const n of nodes(c)) if (n.k === "text") n.styled = true;
    return c;
  };
  return {
    nodes,
    callbacks: {
      heading: (c: string, m: { level: number }) =>
        node({ k: "heading", level: m.level, inline: inline(c) }),
      paragraph: (c: string) => node({ k: "paragraph", inline: inline(c) }),
      blockquote: (c: string) =>
        node({ k: "quote", blocks: nodes(c).filter(isBlock) }),
      list: (c: string, m: { ordered: boolean }) =>
        node({
          k: "list",
          ordered: m.ordered,
          items: nodes(c)
            .filter(isItem)
            .map((i) => i.blocks),
        }),
      listItem: (c: string) =>
        node({ k: "item", blocks: itemBlocks(nodes(c)) }),
      code: () => node({ k: "other", kind: "code" }),
      html: () => node({ k: "other", kind: "html" }),
      hr: () => node({ k: "other", kind: "hr" }),
      table: () => node({ k: "other", kind: "table" }),
      thead: () => "",
      tbody: () => "",
      tr: () => "",
      th: () => "",
      td: () => "",
      strong: styled,
      emphasis: styled,
      strikethrough: styled,
      link: (c: string, m: { href: string }) =>
        node({ k: "link", href: m.href, inline: inline(c) }),
      image: () => node({ k: "other" }),
      codespan: () => node({ k: "other" }),
      text: (t: string) =>
        node(
          HTML_SPAN.test(t) ? { k: "other", html: true } : { k: "text", v: t },
        ),
    },
  };
}

/** The blocks `text` renders as, in order. */
export function parseBlocks(text: string): Block[] {
  const built = callbacks([]);
  const rendered = Bun.markdown.render(
    text,
    built.callbacks as Parameters<typeof Bun.markdown.render>[1],
  );
  return built.nodes(rendered).filter(isBlock);
}

/**
 * The text a reader sees in `inline`: its text and its links' text, without
 * code, HTML or destinations. Line breaks do not render as text pieces, so the
 * words either side of one may meet.
 */
export const plain = (inline: Inline[]): string =>
  inline
    .map((i) => (i.k === "text" ? i.v : i.k === "link" ? plain(i.inline) : " "))
    .join("");

/** The text of every block in `blocks` that shows prose: no code, HTML or table. */
export function prose(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.k === "heading" || b.k === "paragraph") return plain(b.inline);
      if (b.k === "list") return b.items.map(prose).join("\n");
      if (b.k === "quote") return prose(b.blocks);
      return "";
    })
    .join("\n");
}
