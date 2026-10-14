/**
 * Where a link in one of the repository's documents lands on the site.
 *
 * The site renders the repository's Markdown as it is, so the documents keep
 * linking to each other by repository path (`../GLOSSARY.md`,
 * `modules/M2-generated-artifact-freshness/`). A path the site has a page for
 * becomes that page's route; any other path (a template, a script, a
 * reference gate) becomes its address on GitHub, where the source lives.
 */
import { posix } from "node:path";

export const REPO_URL = "https://github.com/docomply/jig";
const REPO_BLOB = `${REPO_URL}/blob/main/`;
const REPO_TREE = `${REPO_URL}/tree/main/`;

/** A module's route id: `M2-generated-artifact-freshness` -> `M2`. */
function moduleId(dir: string): string {
  return dir.split("-")[0] ?? dir;
}

/** A principle's route number: `04-enforcement-ladder.md` -> `4`. */
function principleNumber(file: string): string {
  return String(Number.parseInt(file, 10));
}

const FIXED: Record<string, string> = {
  "README.md": "/",
  "FACTORY.md": "/factory/",
  "GLOSSARY.md": "/glossary/",
  "CHANGELOG.md": "/whats-new/",
  "ROADMAP.md": "/whats-new/#roadmap",
  "modules/README.md": "/modules/",
  "principles/README.md": "/principles/",
  "profiles/README.md": "/adopt/#profiles",
  "adoption/brownfield.md": "/adopt/",
  "adoption/greenfield.md": "/adopt/greenfield/",
  "plugin/README.md": "/plugin/",
  "plugin/CONFIGURATION.md": "/plugin/configuration/",
};

/** Whether a repository path exists (or, for `isFile`, is a file); the default knows of none. */
export type Exists = (path: string) => boolean;

/**
 * The site route for a repository path, or null when the site has no page for
 * it. `path` is relative to the repository root, without a leading `./`; a
 * directory may end in `/`. A skill with a human README has its page from
 * the README and a second page for its SKILL.md; `exists` tells which.
 */
export function siteRoute(
  path: string,
  exists: Exists = () => false,
): string | null {
  const p = path.replace(/\/$/, "");
  const fixed = FIXED[p] ?? FIXED[`${p}/README.md`];
  if (fixed) return fixed;
  let m = /^modules\/(M\d+-[^/]+)(?:\/(README\.md|mappings\.md))?$/.exec(p);
  if (m?.[1]) {
    const base = `/modules/${moduleId(m[1])}/`;
    return m[2] === "mappings.md" ? `${base}mappings/` : base;
  }
  m = /^principles\/(\d\d-[^/]+\.md)$/.exec(p);
  if (m?.[1]) return `/principles/${principleNumber(m[1])}/`;
  m = /^plugin\/skills\/([^/]+)(?:\/(README|SKILL)\.md)?$/.exec(p);
  if (m?.[1]) {
    const ownPage =
      m[2] === "SKILL" && exists(`plugin/skills/${m[1]}/README.md`);
    return ownPage ? `/skills/${m[1]}/skill/` : `/skills/${m[1]}/`;
  }
  m = /^plugin\/agents\/([^/]+)\.md$/.exec(p);
  if (m?.[1]) return `/skills/${m[1]}/`;
  return null;
}

/**
 * The repository address of a path: a file opens as a blob, a directory as a
 * tree. A path `isFile` knows is a file is one (`LICENSE`); otherwise a path
 * without an extension is taken for a directory.
 */
function repoUrl(path: string, isFile: Exists = () => false): string {
  const p = path.replace(/^\/+/, "");
  const isDir =
    p === "" ||
    p.endsWith("/") ||
    (!isFile(p) && !posix.basename(p).includes("."));
  return (isDir ? REPO_TREE : REPO_BLOB) + p.replace(/\/+$/, "");
}

/**
 * The anchors a designed page gives a document's headings, where they differ
 * from the heading anchors the document's own links use. The roadmap renders
 * as groups (`rm-<name>`) and numbered items (`rm-item-<n>`); the factory page
 * names its sections itself.
 */
const ANCHORS: Record<string, (anchor: string) => string> = {
  "ROADMAP.md": (anchor) => {
    const n = /^(\d+)-/.exec(anchor)?.[1];
    return n ? `rm-item-${n}` : `rm-${anchor}`;
  },
  "FACTORY.md": (anchor) =>
    ({ "the-learning-loop-wraps-both": "learning" })[anchor] ?? anchor,
};

/** The anchor on the site for an anchor in the document at `path`. */
function siteAnchor(path: string, anchor: string): string {
  return anchor ? (ANCHORS[path]?.(anchor) ?? anchor) : "";
}

/** Joins a route and an anchor; the anchor replaces one the route carries. */
function withAnchor(route: string, anchor: string): string {
  return anchor ? `${route.split("#")[0]}#${anchor}` : route;
}

export interface ResolveContext {
  linkText?: string;
  glossaryAnchor?: (text: string) => string | null;
  exists?: Exists;
  isFile?: Exists;
}

/**
 * The repository path a link points at, or null when it points outside the
 * repository (another site, protocol-relative `//host/` included, or above
 * the repository root).
 */
function repoTarget(bare: string, from: string): string | null {
  if (/^(https?:)?\/\//.test(bare)) {
    const prefix = [REPO_BLOB, REPO_TREE].find((u) => bare.startsWith(u));
    return prefix ? bare.slice(prefix.length) : null;
  }
  const target = posix.normalize(posix.join(posix.dirname(from), bare));
  if (target.startsWith("..")) return null;
  return bare.endsWith("/") && !target.endsWith("/") ? `${target}/` : target;
}

/**
 * Where `href`, written in the document at repository path `from`, should
 * point on the site. External links and links the site cannot place are
 * returned unchanged; an anchor alone points at a heading of the document
 * itself, on that document's page. `glossaryAnchor` resolves a link to
 * the glossary without an anchor (the documents' usual form) to the entry
 * its link text names; `exists` is passed to `siteRoute`, and `isFile` tells
 * a file without an extension from a directory.
 */
export function resolveHref(
  href: string,
  from: string,
  context: ResolveContext = {},
): string {
  const {
    linkText = "",
    glossaryAnchor = () => null,
    exists,
    isFile,
  } = context;
  if (
    !href ||
    (href.startsWith("/") && !href.startsWith("//")) ||
    /^(mailto|tel):/.test(href)
  )
    return href;
  if (href.startsWith("#")) {
    // A heading of this document, which the site may render on another page
    // than the one this part of it appears on.
    const route = siteRoute(from, exists);
    return route ? withAnchor(route, siteAnchor(from, href.slice(1))) : href;
  }
  const [bare = "", anchor = ""] = href.split("#", 2);
  const target = repoTarget(bare, from);
  if (target === null) return href;
  const route = siteRoute(target, exists);
  if (!route) return withAnchor(repoUrl(target, isFile), anchor);
  const glossaryTerm =
    route === "/glossary/" && !anchor ? glossaryAnchor(linkText) : null;
  return withAnchor(
    route,
    glossaryTerm ?? siteAnchor(target.replace(/\/$/, ""), anchor),
  );
}
