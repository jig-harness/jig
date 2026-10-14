// Checks the built site: every link to a page of the site lands on a page
// that exists, and every anchor on an id that page has. The site renders the
// repository's documents, so a renamed heading or a moved file in a document
// shows up here as a failing link. Exit 1 lists each broken link and the page
// it is on; exit 2 when there is no build to check.
//
// Links and ids are read from the elements an HTML parser finds, so text in
// a comment or a script is neither a link nor a target. Every link is
// resolved against the page it is on, as a browser would: `#part` and
// `other/` are checked as well as `/route/`.
//
// An anchor is checked against the ids of the file it lands on, whatever kind
// of file that is. HTML and SVG files are read for their ids (an SVG's
// `<symbol id>` is what `<use href="/sprite.svg#icon">` names), and their own
// links are checked too; any other file has no ids, so an anchor on it is
// broken.
//
// A file that sets its own base URL (HTML's `<base href>`, or an `xml:base`
// attribute in an SVG) is reported rather than checked: its links are not
// resolved against the file's route, and a check that resolved them there
// would certify the wrong destinations.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cli } from "../../lib/cli.ts";
import { SITE_ORIGIN } from "../src/lib/origin.ts";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
/**
 * A stand-in origin to resolve links against. A link to it or to the site's
 * own address is a link within the site; any other is another site's.
 */
const ORIGIN = "https://site.invalid";

interface Page {
  ids: Set<string>;
  hrefs: string[];
  /** The file sets its own base URL, so its links cannot be checked here. */
  rebased: boolean;
}

/** The built files with ids and links of their own: HTML pages and SVG images. */
function documentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return documentFiles(path);
    return /\.(html|svg)$/.test(name) ? [path] : [];
  });
}

/** The route a built file serves: `modules/M2/index.html` -> `/modules/M2/`. */
function routeOf(file: string): string {
  return normalRoute(`/${relative(dist, file).split(sep).join("/")}`);
}

/** `/x/index.html` and `/x/` are one page. */
function normalRoute(path: string): string {
  return path.endsWith("/index.html")
    ? path.slice(0, -"index.html".length)
    : path;
}

/**
 * Every attribute a browser follows or loads a URL from, as the selector that
 * finds it. They are matched on any element, not on a list of elements, so an
 * element that carries one of these attributes is checked without being named
 * here: SVG's `<image href>` and `<use href>` as well as HTML's `<a href>`.
 * Only `data` means a URL on one element alone (`<object>`). The value is one
 * URL, or for a `srcset` kind a list of candidates.
 */
const URL_ATTRIBUTES: { selector: string; name: string; srcset?: true }[] = [
  { selector: "[href]", name: "href" },
  { selector: "[xlink\\:href]", name: "xlink:href" },
  { selector: "[src]", name: "src" },
  { selector: "[srcset]", name: "srcset", srcset: true },
  { selector: "[imagesrcset]", name: "imagesrcset", srcset: true },
  { selector: "[poster]", name: "poster" },
  { selector: "[action]", name: "action" },
  { selector: "[formaction]", name: "formaction" },
  { selector: "object[data]", name: "data" },
];

/**
 * The URLs in a `srcset`, read as the HTML standard reads it: a candidate's
 * address runs to the next space and may contain commas, except trailing
 * ones, which end the candidate; its descriptor runs to the next comma.
 */
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value.charAt(i))) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value.charAt(i))) i++;
    const url = value.slice(start, i);
    const bare = url.replace(/,+$/, "");
    if (bare) urls.push(bare);
    if (bare === url) while (i < value.length && value.charAt(i) !== ",") i++;
  }
  return urls;
}

/** The ids a page's elements carry and the links and sources they load. */
export async function parsePage(html: string): Promise<Page> {
  const page: Page = { ids: new Set(), hrefs: [], rebased: false };
  const rebase = {
    element() {
      page.rebased = true;
    },
  };
  let rewriter = new HTMLRewriter()
    .on("[id]", {
      element(el) {
        page.ids.add(el.getAttribute("id") ?? "");
      },
    })
    .on("base[href]", rebase)
    .on("[xml\\:base]", rebase);
  for (const { selector, name, srcset } of URL_ATTRIBUTES)
    rewriter = rewriter.on(selector, {
      element(el) {
        const value = el.getAttribute(name) ?? "";
        if (srcset) page.hrefs.push(...srcsetUrls(value));
        else page.hrefs.push(value);
      },
    });
  await rewriter.transform(new Response(html)).text();
  return page;
}

/** Each built page's or SVG's route, with its ids and links. */
async function readPages(): Promise<Map<string, Page>> {
  const pages = new Map<string, Page>();
  for (const file of documentFiles(dist))
    pages.set(routeOf(file), await parsePage(readFileSync(file, "utf8")));
  return pages;
}

/** Why a link on the page at `route` is broken, or null when it resolves or leaves the site. */
export function problemWith(
  href: string,
  route: string,
  pages: Map<string, Pick<Page, "ids">>,
  isAsset: (path: string) => boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(href, `${ORIGIN}${route}`);
  } catch {
    return "not a valid address";
  }
  if (url.origin !== ORIGIN && url.origin !== SITE_ORIGIN) return null;
  const path = decodeURI(url.pathname);
  const page =
    pages.get(normalRoute(path)) ??
    (path.endsWith("/") ? undefined : pages.get(`${path}/`));
  const anchor = decodeURIComponent(url.hash.slice(1));
  if (!page) {
    if (!isAsset(path)) return "no such page";
    return anchor ? "no such anchor" : null;
  }
  if (anchor && !page.ids.has(anchor)) return "no such anchor";
  return null;
}

/** A built file with no ids: a raster image, a font, a stylesheet, a feed. */
function isAsset(path: string): boolean {
  const file = join(dist, path);
  return !path.endsWith(".html") && existsSync(file) && statSync(file).isFile();
}

async function checkLinks(): Promise<number> {
  if (!existsSync(dist)) {
    console.error("check-links: no dist/ folder; run the build first");
    return 2;
  }
  const pages = await readPages();
  if (!pages.has("/")) {
    console.error("check-links: dist/ has no home page; run the build first");
    return 2;
  }
  const broken: string[] = [];
  for (const [route, { hrefs, rebased }] of pages) {
    if (rebased) {
      broken.push(
        `${route}: sets its own base URL, which check-links does not resolve`,
      );
      continue;
    }
    for (const href of hrefs) {
      const problem = problemWith(href, route, pages, isAsset);
      if (problem) broken.push(`${route}: ${href} (${problem})`);
    }
  }
  if (broken.length) {
    console.error(
      `check-links: ${broken.length} problem(s)\n${broken.join("\n")}`,
    );
    return 1;
  }
  console.log(`check-links: ${pages.size} files, every site link resolves`);
  return 0;
}

if (import.meta.main) cli(checkLinks);
