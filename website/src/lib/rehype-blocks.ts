/**
 * Rehype plugin: the site's form for two kinds of block.
 *
 * - A fenced code block becomes a figure that names its language and carries
 *   a Copy button (scripts/copy.ts copies the code beside it).
 * - A table is wrapped so it scrolls sideways on a narrow screen instead of
 *   widening the page.
 */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const el = (
  tagName: string,
  properties: Record<string, unknown>,
  children: HNode[],
): HNode => ({ type: "element", tagName, properties, children });

const text = (value: string): HNode => ({ type: "text", value });

/** The language a `<code>` names in its class (`language-yaml`), or "text". */
function languageOf(code: HNode | undefined): string {
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  const lang = list.find((c) => c.startsWith("language-"));
  return lang ? lang.slice("language-".length) : "text";
}

function codeFigure(pre: HNode): HNode {
  const code = pre.children?.find((c) => c.tagName === "code");
  return el("figure", { className: ["code"] }, [
    el("figcaption", {}, [
      el("span", {}, [text(languageOf(code))]),
      el("button", { type: "button", className: ["copy"], dataCopy: "" }, [
        text("Copy"),
      ]),
    ]),
    pre,
  ]);
}

function transform(node: HNode): void {
  const children = node.children;
  if (!children) return;
  for (const [i, child] of children.entries()) {
    if (child.tagName === "pre") children[i] = codeFigure(child);
    else if (child.tagName === "table")
      children[i] = el("div", { className: ["table-wrap"] }, [child]);
    else transform(child);
  }
}

export function rehypeBlocks() {
  return (tree: HNode) => transform(tree);
}
