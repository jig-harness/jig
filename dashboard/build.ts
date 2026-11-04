#!/usr/bin/env bun
/**
 * Builds the page `jig dispatch dashboard` serves. The plugin runs from a copy
 * with no `node_modules`, so it carries the page as files Jig builds from the
 * source in `src/` and the pinned packages, with Bun's bundler, and writes:
 *
 *   plugin/dispatch/dashboard-page/index.html     the page, script and styles inline
 *   plugin/dispatch/dashboard-page/refused.html   the page a request without the token gets, no script
 *   plugin/dispatch/dashboard-page/bundle.LICENSE the licence of each package in the bundle
 *
 * Usage:
 *   bun dashboard/build.ts           write the three files
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

function document(title: string, styles: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    // A browser asks for an icon by itself, without the token, and is refused;
    // naming an empty one means it does not ask.
    '<link rel="icon" href="data:,">',
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
    ),
    "refused.html": document(
      "Dispatch: refused",
      styles,
      renderToStaticMarkup(createElement(Refused)),
    ),
    "bundle.LICENSE": licences(inputs),
  };
}

async function main(args: string[]): Promise<number> {
  const files = await buildPage();
  if (args.includes("--check")) {
    const stale = Object.entries(files)
      .filter(([name, content]) => {
        const path = join(ROOT, PAGE_DIR, name);
        return !existsSync(path) || readFileSync(path, "utf8") !== content;
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
