#!/usr/bin/env bun
/**
 * Builds the page `jig dispatch dashboard` serves. The plugin runs from a copy
 * with no `node_modules`, so it carries the page as files Jig builds from the
 * source in `src/` and the pinned packages, with Bun's bundler, and writes:
 *
 *   plugin/dispatch/dashboard-page/index.html            the page, script and styles inline
 *   plugin/dispatch/dashboard-page/refused.html          the page a request without the token gets, no script
 *   plugin/dispatch/dashboard-page/bundle.LICENSE        the licence of each package in the bundle
 *   plugin/dispatch/dashboard-page/manifest.webmanifest  what a phone's browser needs to install the page as an app
 *   plugin/dispatch/dashboard-page/icons/*.png           the app's icons, copied from `icons/`
 *
 * Usage:
 *   bun dashboard/build.ts           write the files
 *   bun dashboard/build.ts --check   exit 1 naming each file that
 *                                                   differs from a fresh build
 *
 * The build is what the pinned Bun writes for the pinned packages, so an update
 * of either is followed by a run of this script.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cli } from "../lib/cli.ts";
import { Refused } from "./src/refused.tsx";
import styles from "./src/styles.css" with { type: "text" };

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = "dashboard/src";
export const PAGE_DIR = "plugin/dispatch/dashboard-page";
const COMMAND = "bun dashboard/build.ts";
/** Jig's square mark, the one that follows the reader's theme: the site's favicon too. */
const MARK = "website/public/brand/jig-mark-adaptive.svg";
/** The page's colours as the stylesheet sets them (`--bg`), for the browser's own chrome around an installed page. */
const THEME = { light: "#f9f6f1", dark: "#1a1713" };
/** The app's icons, as `icons/` holds them: a PNG a launcher shows as it is, and a full-bleed one it may crop to its own shape. */
const ICONS = [
  { file: "icon-192.png", sizes: "192x192", purpose: "any" },
  { file: "icon-512.png", sizes: "512x512", purpose: "any" },
  { file: "icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
] as const;
const LICENCE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "license",
  "license.md",
];

/** A page that could not be built; the message says why. */
class PageBuildError extends Error {
  override name = "PageBuildError";
}

/**
 * Text that is safe inside an inline `<script>`. A script ends at the first
 * `</script`, and `<!--` changes how the parser reads what follows, wherever
 * either stands in the program, so each is written with an escape that means
 * the same in a string, a template or a pattern.
 */
function inlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** The mark as an address the page holds itself. */
function icon(): string {
  const svg = readFileSync(join(ROOT, MARK), "utf8").trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The manifest. It starts the app at `/` and never at an address with a token:
 * an installed app opens from that address, so one that carried the token
 * would put it on the home screen. A server that asks for a token refuses the
 * manifest with everything else, and the page is then not offered for install.
 */
function manifest(): string {
  return `${JSON.stringify(
    {
      id: "/",
      name: "Jig dispatch",
      short_name: "Dispatch",
      description: "What the dispatcher is doing and what waits for a person.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: THEME.light,
      theme_color: THEME.light,
      icons: ICONS.map(({ file, sizes, purpose }) => ({
        src: `/icons/${file}`,
        sizes,
        type: "image/png",
        purpose,
      })),
    },
    null,
    2,
  )}\n`;
}

/** The tags that make a page installable: the manifest, and the browser's own bar in the page's colours. */
const INSTALLABLE = [
  // Without `crossorigin`, a browser fetches the manifest with no cookies, so a
  // front that keeps its sign-in in a cookie would answer it with a sign-in page.
  '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">',
  `<meta name="theme-color" content="${THEME.light}" media="(prefers-color-scheme: light)">`,
  `<meta name="theme-color" content="${THEME.dark}" media="(prefers-color-scheme: dark)">`,
];

function document(
  title: string,
  styles: string,
  body: string,
  head: string[] = [],
): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    // A browser asks for an icon by itself, without the token, and is refused;
    // an icon the page holds inline means it does not ask.
    `<link rel="icon" href="${icon()}">`,
    ...head,
    `<title>${title}</title>`,
    `<style>${styles}</style>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
    "",
  ].join("\n");
}

/** The directory of the package an input of the bundle belongs to, under `node_modules`; `null` for the page's own source. */
function packageOf(input: string): string | null {
  const at = input.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const parts = input.slice(at + "node_modules/".length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  return name === undefined ? null : join("node_modules", name);
}

/** The package's licence text; a package that publishes none is named by what its manifest declares. */
function licenceOf(directory: string, declared: unknown): string {
  for (const name of LICENCE_NAMES) {
    const path = join(ROOT, directory, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  if (typeof declared === "string")
    return `Licensed ${declared}, as its package manifest declares; the package publishes no licence file.`;
  throw new PageBuildError(`${directory} carries no licence file`);
}

/** Each package in the bundle, by what the bundler read, with its version and licence. */
function licences(inputs: string[]): string {
  const packages = [
    ...new Set(inputs.map(packageOf).filter((p): p is string => p !== null)),
  ].sort((a, b) => a.localeCompare(b));
  return `${packages
    .map((directory) => {
      const manifest = Bun.JSONC.parse(
        readFileSync(join(ROOT, directory, "package.json"), "utf8"),
      ) as { name: string; version: string; license?: unknown };
      return `${manifest.name} ${manifest.version}\n\n${licenceOf(directory, manifest.license).trim()}\n`;
    })
    .join("\n----------------------------------------\n\n")}`;
}

/** The three files, by name. The bundler runs from the repository root, so its output does not depend on where this was called from. */
export async function buildPage(): Promise<Record<string, string>> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, SOURCE, "main.tsx")],
    root: ROOT,
    target: "browser",
    format: "iife",
    minify: true,
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: join(ROOT, "dashboard/tsconfig.json"),
  });
  const script = built.outputs.find((o) => o.path.endsWith(".js"));
  if (script === undefined)
    throw new PageBuildError(`bundling ${SOURCE}/main.tsx wrote no script`);
  const inputs = Object.keys(built.metafile?.inputs ?? {});
  if (inputs.length === 0)
    throw new PageBuildError("the bundler reported no inputs");
  return {
    "index.html": document(
      "Dispatch",
      styles,
      `<div id="root"></div>\n<script>${inlineScript(await script.text())}</script>`,
      INSTALLABLE,
    ),
    "refused.html": document(
      "Dispatch: refused",
      styles,
      renderToStaticMarkup(createElement(Refused)),
    ),
    "bundle.LICENSE": licences(inputs),
    "manifest.webmanifest": manifest(),
  };
}

/** The icons, copied as they are from `icons/`, by the path they are written at. */
export function buildIcons(): Record<string, Uint8Array> {
  return Object.fromEntries(
    ICONS.map(({ file }) => [
      `icons/${file}`,
      new Uint8Array(readFileSync(join(ROOT, "dashboard/icons", file))),
    ]),
  );
}

async function main(args: string[]): Promise<number> {
  const files: Record<string, string | Uint8Array> = {
    ...(await buildPage()),
    ...buildIcons(),
  };
  if (args.includes("--check")) {
    const stale = Object.entries(files)
      .filter(([name, content]) => {
        const path = join(ROOT, PAGE_DIR, name);
        return (
          !existsSync(path) ||
          !Buffer.from(readFileSync(path)).equals(Buffer.from(content))
        );
      })
      .map(([name]) => join(PAGE_DIR, name));
    if (stale.length > 0)
      console.error(
        `${stale.join(", ")} differ from a fresh build; run ${COMMAND}`,
      );
    return stale.length === 0 ? 0 : 1;
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(ROOT, PAGE_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${join(PAGE_DIR, name)}`);
  }
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
