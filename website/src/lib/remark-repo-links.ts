/**
 * Remark plugin: makes the repository's Markdown work as site pages.
 *
 * - Every link and link definition is resolved from the document's own
 *   repository path (see `routes.ts`). A reference-style link (`[Drift][g]`)
 *   becomes an inline link to its definition's address, resolved with its
 *   own text, so two references to one definition can name two terms. A link to a glossary entry becomes a
 *   term (`class="term"`, `data-term`), whose definition opens beside it; a
 *   link to the repository's source is marked as one (`class="out"`).
 * - A link to a skill, the agent or a tool carries what it does
 *   (`data-tip-*`), so hovering it opens the same popover as the actor chips
 *   in the figures, and a link whose text is the bare name draws the actor's
 *   glyph before it (`class="actor-ref"`).
 * - In GLOSSARY.md, each entry's list item gets the entry's anchor as its id,
 *   so `/glossary/#drift` lands on the definition, and an italic phrase that
 *   names another entry (the glossary's cross-reference form) links to it.
 *
 * It walks the syntax tree itself, so the site needs no tree-walking package.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { clip, plain } from "./data/modules.ts";
import { parseSkills, type Skill } from "./data/skills.ts";
import { firstParagraph } from "./source.ts";
import { anchorFor, type GlossaryEntry, parseGlossary } from "./glossary.ts";
import { REPO_URL, resolveHref } from "./routes.ts";

interface MdNode {
  type: string;
  url?: string;
  title?: string | null;
  identifier?: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

interface VFileLike {
  path?: string;
  history?: string[];
}

function textOf(node: MdNode): string {
  if (node.value) return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function walk(node: MdNode, visit: (n: MdNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function withProps(node: MdNode, props: Record<string, unknown>): void {
  node.data = {
    ...node.data,
    hProperties: { ...node.data?.hProperties, ...props },
  };
}

/** The bold term a glossary list item opens with, if it is an entry. */
function entryTerm(item: MdNode): string | null {
  const para = item.children?.[0];
  const strong = para?.type === "paragraph" ? para.children?.[0] : undefined;
  return strong?.type === "strong" ? textOf(strong) : null;
}

/** The address and title of each link definition, by its identifier. */
function definitionsOf(tree: MdNode): Map<string, MdNode> {
  const out = new Map<string, MdNode>();
  walk(tree, (node) => {
    if (
      node.type === "definition" &&
      node.identifier &&
      !out.has(node.identifier)
    )
      out.set(node.identifier, {
        type: "link",
        url: node.url,
        title: node.title,
      });
  });
  return out;
}

/** A reference to a known definition, turned into the link it stands for. */
function inlineReference(node: MdNode, definitions: Map<string, MdNode>): void {
  const target = node.identifier ? definitions.get(node.identifier) : undefined;
  if (node.type !== "linkReference" || !target) return;
  node.type = "link";
  node.url = target.url;
  node.title = target.title ?? null;
}

/** What a site page is called when a link names it by its file. */
const PAGE_NAMES: Record<string, string> = {
  "/": "the overview",
  "/adopt/": "the adoption guide",
  "/adopt/greenfield/": "the greenfield guide",
  "/plugin/": "the plugin page",
  "/plugin/configuration/": "the configuration page",
  "/whats-new/": "What's new",
  "/whats-new/#roadmap": "the roadmap",
  "/factory/": "the factory page",
  "/modules/": "the module map",
  "/principles/": "the principles",
  "/glossary/": "the glossary",
};

/**
 * A link whose text is a bare file name (`adoption/greenfield.md`) reads as
 * the name of the site page it now opens ("the greenfield guide").
 */
function renamePathLink(node: MdNode): void {
  const only = node.children?.length === 1 ? node.children[0] : undefined;
  const text =
    only && (only.type === "text" || only.type === "inlineCode")
      ? (only.value ?? "")
      : "";
  const name = PAGE_NAMES[node.url ?? ""];
  if (name && /^[\w./-]+(\.md|\/)$/.test(text) && node.children)
    node.children = [{ type: "text", value: name }];
}

/** What a link to an actor (a skill, the agent, a tool) opens beside itself. */
interface ActorTip {
  name: string;
  kind: "skill" | "agent" | "tool";
  head: string;
  body: string;
  more: string;
}

/** The popover a link opens, by the actor its address names, or null. */
type ActorTips = (url: string) => ActorTip | null;

function actorTips(repoRoot: string): ActorTips {
  let skills: Skill[] | undefined;
  const tools = new Map<string, string>();
  return (url) => {
    const skill = /^\/skills\/([a-z-]+)\/(?:skill\/)?$/.exec(url)?.[1];
    if (skill) {
      skills ??= parseSkills(
        readFileSync(join(repoRoot, "plugin/README.md"), "utf8"),
      );
      const s = skills.find((k) => k.name === skill);
      if (!s) return null;
      return s.agent
        ? {
            name: s.name,
            kind: "agent",
            head: `Agent · ${s.command}`,
            body: clip(plain(s.purpose), 220),
            more: "Open the agent →",
          }
        : {
            name: s.name,
            kind: "skill",
            head: `Skill · ${s.command}`,
            body: clip(plain(s.purpose), 220),
            more: "Open the skill →",
          };
    }
    const tool = new RegExp(
      `^${REPO_URL}/(?:blob|tree)/main/tools/([a-z-]+)(?:/README\\.md)?$`,
    ).exec(url)?.[1];
    if (tool) {
      const readme = join(repoRoot, `tools/${tool}/README.md`);
      if (!existsSync(readme)) return null;
      if (!tools.has(tool))
        tools.set(
          tool,
          clip(plain(firstParagraph(readFileSync(readme, "utf8"))), 220),
        );
      return {
        name: tool,
        kind: "tool",
        head: "Tool · runs outside the agent",
        body: tools.get(tool) ?? "",
        more: "Open its README →",
      };
    }
    return null;
  };
}

/** Marks a resolved link as a term, an actor, or a link to the source. */
function markLink(node: MdNode, tips: ActorTips): void {
  const url = node.url ?? "";
  const term = /^\/glossary\/#(.+)$/.exec(url)?.[1];
  const actor = tips(url);
  if (term) withProps(node, { className: ["term"], "data-term": term });
  else if (actor) {
    const bare = textOf(node) === actor.name;
    withProps(node, {
      className: bare ? ["actor-ref", actor.kind] : [`${actor.kind}-link`],
      "data-tip-head": actor.name,
      "data-tip-kind": actor.head,
      "data-tip-body": actor.body,
      "data-tip-more": actor.more,
      ...(url.startsWith(REPO_URL)
        ? { title: "Opens in the Jig repository" }
        : {}),
    });
  } else if (url.startsWith(REPO_URL))
    withProps(node, {
      className: ["out"],
      title: "Opens in the Jig repository",
    });
}

/** In the glossary: ids on entries, links on italic cross-references. */
function glossaryNode(
  node: MdNode,
  entries: GlossaryEntry[],
  tips: ActorTips,
): void {
  if (node.type === "listItem") {
    const term = entryTerm(node);
    const anchor = term ? entries.find((e) => e.term === term)?.anchor : null;
    if (anchor) withProps(node, { id: anchor });
    return;
  }
  if (node.type === "link") return;
  for (const [i, child] of (node.children ?? []).entries()) {
    if (child.type !== "emphasis") continue;
    const anchor = anchorFor(entries, textOf(child));
    if (!anchor || !node.children) continue;
    const link: MdNode = {
      type: "link",
      url: `/glossary/#${anchor}`,
      children: [child],
    };
    markLink(link, tips);
    node.children[i] = link;
  }
}

export function remarkRepoLinks(options: { repoRoot: string }) {
  const entries = parseGlossary(
    readFileSync(join(options.repoRoot, "GLOSSARY.md"), "utf8"),
  );
  const glossaryAnchor = (text: string) => anchorFor(entries, text);
  const tips = actorTips(options.repoRoot);
  const exists = (path: string) => existsSync(join(options.repoRoot, path));
  const isFile = (path: string) =>
    statSync(join(options.repoRoot, path), {
      throwIfNoEntry: false,
    })?.isFile() === true;
  return () => (tree: MdNode, file: VFileLike) => {
    const abs = file.path ?? file.history?.[0];
    if (!abs) return;
    const from = relative(options.repoRoot, abs).split(sep).join("/");
    const isGlossary = from === "GLOSSARY.md";
    const definitions = definitionsOf(tree);
    walk(tree, (node) => {
      inlineReference(node, definitions);
      if ((node.type === "link" || node.type === "definition") && node.url) {
        node.url = resolveHref(node.url, from, {
          linkText: textOf(node),
          glossaryAnchor,
          exists,
          isFile,
        });
        if (node.type === "link") {
          renamePathLink(node);
          markLink(node, tips);
        }
      }
      if (isGlossary) glossaryNode(node, entries, tips);
    });
  };
}
