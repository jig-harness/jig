#!/usr/bin/env bun
/**
 * Unpack a design round's export into pages a browser renders on its own.
 *
 * The design tool exports one self-extracting HTML file per canvas page: a
 * board of nested pages, each a gzip-compressed, base64-encoded document in
 * a manifest, each loading the tool's page runtime and React from the same
 * manifest at run time. Nothing in it renders without that unpacker, and
 * the landing check (`design-brief-builder`) refuses frames and network
 * requests, so this script reads the bundle's exports, `export.html` and
 * then each addendum `export-<name>.html` beside it in name order, and
 * writes, beside them:
 *
 * - `generated/<title-slug>.html` for every page that stands on its own
 *   (holds an `<x-dc>` template, and every component it imports with
 *   `<dc-import name="X">`, directly or through another component, is
 *   carried in its own manifest as `./X.dc.html`), with the runtime's
 *   manifest reference replaced by scripts at the end of its body: the
 *   imported components' sources, inline; the scenario hook below, inline;
 *   the React builds, by path; and the page runtime as exported, inline;
 *   every page of every export must carry the same React builds and
 *   runtime, and no two pages may share a file name;
 * - `vendor/react.production.min.js` and `vendor/react-dom.production.min.js`,
 *   the React builds as exported (their licence stays in `vendor/LICENSE`).
 *
 * The runtime loads an imported component by reading `./X.dc.html`
 * through `window.__resources` and `window.__resourceBlobs` when the page
 * maps it there, and over the network otherwise; the generated page maps
 * each one to its inline source, so it still loads nothing.
 *
 * The scenario hook, which is not part of the design, reads the page's
 * props from the URL before the runtime boots (`?<prop>=<value>` for a prop
 * with listed options, `?<prop>=true|false` for a boolean, and `?switch=off`
 * to hide the prototype's own switch), and marks the document ready
 * (`html[data-scenario-ready]`) once the page has rendered, so the landing
 * check opens one scenario per URL and waits for it.
 *
 * Every generated page also gets a viewport declaration, which the export's
 * pages lack, so a phone lays them out at its own width.
 *
 * Usage: `bun tools/design/unpack-export.ts [--check] <bundle-dir>`, where
 * the bundle holds `export.html`. `generated/` is replaced whole, and only
 * after every export has unpacked; `--check` writes nothing and exits 1
 * naming each file that differs from a fresh unpacking. Exit 2 when a file
 * is not such an export.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cli } from "../../lib/cli.ts";
import {
  decodeJson,
  isRecord,
  isString,
  isStringArray,
} from "../../plugin/shared/guards.ts";

interface Asset {
  mime: string;
  compressed?: boolean;
  data: string;
}

/** A path the page's runtime asks for, and the manifest entry that answers it. */
interface Resource {
  id: string;
  uuid: string;
}

interface Bundle {
  manifest: Record<string, Asset>;
  template: string;
  pageOrder: string[];
  resources: Resource[];
}

function section(html: string, kind: string): string | null {
  const found = new RegExp(
    `<script type="__bundler/${kind}"[^>]*>([\\s\\S]*?)</script>`,
  ).exec(html);
  return found === null ? null : (found[1] as string);
}

function isAsset(value: unknown): value is Asset {
  return (
    isRecord(value) &&
    isString(value.mime) &&
    isString(value.data) &&
    (value.compressed === undefined || typeof value.compressed === "boolean")
  );
}

function isManifest(value: unknown): value is Record<string, Asset> {
  return isRecord(value) && Object.values(value).every(isAsset);
}

function isResources(value: unknown): value is Resource[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isRecord(entry) && isString(entry.id) && isString(entry.uuid),
    )
  );
}

/** The bundle a self-extracting document carries; `null` when it carries none. */
export function parseBundle(html: string): Bundle | null {
  const manifest = section(html, "manifest");
  const template = section(html, "template");
  if (manifest === null || template === null) return null;
  const order = section(html, "page_order");
  const resources = section(html, "ext_resources");
  return {
    manifest: decodeJson(manifest, isManifest, "the export's manifest"),
    template: decodeJson(template, isString, "the export's template"),
    pageOrder:
      order === null
        ? []
        : decodeJson(order, isStringArray, "the export's page order"),
    resources:
      resources === null
        ? []
        : decodeJson(resources, isResources, "the export's resources"),
  };
}

/** An asset's bytes, decompressed when the manifest says so. */
export function assetText(asset: Asset): string {
  const bytes = Buffer.from(asset.data, "base64");
  const plain = asset.compressed ? Bun.gunzipSync(bytes) : bytes;
  return new TextDecoder().decode(plain);
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const REACT_FILES = ["react.production.min.js", "react-dom.production.min.js"];

/** Which React build a script asset is, by the licence header it opens with. */
function reactFile(text: string): string | undefined {
  const head = text.slice(0, 200);
  return REACT_FILES.find(
    (name) => head.includes(`@license React`) && head.includes(` * ${name}`),
  );
}

/**
 * The scenario hook, inlined into every generated page before the runtime.
 * It first gives the runtime the page's template as the export's own
 * loader does: a resource map, so the runtime never re-reads the page's
 * text, and an `x-dc` element whose markup is read from the inert
 * `<template data-dc-source>` the page carries it in, so the browser never
 * requests an address the template has yet to fill in (`href="{{x.icon}}"`).
 */
const HOOK = `(function () {
  window.__resources = window.__resources || {};
  var source = document.querySelector("template[data-dc-source]");
  var parsed = source && source.content && source.content.querySelector("x-dc");
  if (parsed) {
    var host = document.createElement("x-dc");
    for (var i = 0; i < parsed.attributes.length; i++)
      host.setAttribute(parsed.attributes[i].name, parsed.attributes[i].value);
    Object.defineProperty(host, "innerHTML", {
      configurable: true,
      get: function () {
        return parsed.innerHTML;
      },
    });
    source.replaceWith(host);
  }
  var query = new URLSearchParams(location.search);
  var script = document.querySelector("script[data-dc-script]");
  if (script) {
    try {
      var props = JSON.parse(script.getAttribute("data-props") || "{}");
      Object.keys(props).forEach(function (name) {
        var value = query.get(name);
        var prop = props[name];
        if (!value || !prop || typeof prop !== "object") return;
        if (prop.options) {
          if (prop.options.indexOf(value) >= 0) prop.default = value;
        } else if (prop.editor === "boolean") prop.default = value === "true";
      });
      if (query.get("switch") === "off" && props.showSwitch) props.showSwitch.default = false;
      script.setAttribute("data-props", JSON.stringify(props));
    } catch (error) {
      // A page without props is rendered as it is.
    }
  }
  var mark = function () {
    var root = document.getElementById("dc-root");
    if (!root || !root.firstElementChild) return false;
    document.documentElement.setAttribute("data-scenario-ready", "");
    return true;
  };
  if (!mark()) {
    var observer = new MutationObserver(function () {
      if (mark()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;

/**
 * Script text as an inline script's body. The HTML tokenizer ends a script
 * element at `</script` and, after a `<!--`, treats a later `<script` as
 * opening a nested one; a backslash before `/` and `!` reads the same in
 * JavaScript and keeps both inert.
 */
function inline(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

/**
 * The script that hands the runtime each imported component's source:
 * a `Blob` in `window.__resourceBlobs`, named for its path in
 * `window.__resources`. Empty when the page imports none.
 */
function componentScript(components: Map<string, string>): string {
  if (components.size === 0) return "";
  return `<script>
/* The components this page imports, as exported, for the runtime to read. */
${inline(`(function () {
  var components = ${JSON.stringify(Object.fromEntries(components))};
  var resources = (window.__resources = window.__resources || {});
  var blobs = (window.__resourceBlobs = window.__resourceBlobs || {});
  Object.keys(components).forEach(function (path) {
    var key = "inline:" + path;
    blobs[key] = new Blob([components[path]], { type: "text/html" });
    resources[path] = key;
  });
})();`)}
</script>
`;
}

/** The scripts a generated page ends its body with. */
function scripts(runtime: string, components: Map<string, string>): string {
  return `${componentScript(components)}<script>
/* Landing-check hook, not part of the design (tools/design/unpack-export.ts). */
${inline(HOOK)}
</script>
<script src="../vendor/react.production.min.js"></script>
<script src="../vendor/react-dom.production.min.js"></script>
<script>
/* The design tool's page runtime, as exported. */
${inline(runtime)}
</script>
`;
}

/** A file that is not an export, or an export this script cannot unpack. */
export class UnpackError extends Error {
  override name = "UnpackError";
}

export interface Unpacked {
  pages: string[];
  skipped: string[];
  react: string[];
}

/** What the pages share: the one runtime, inlined into each, and the React builds, kept once. */
interface Shared {
  runtime: string | null;
  react: Map<string, string>;
}

/** A page's title, for its file name and its messages. */
function titleOf(template: string, fallback: string): string {
  return /<title>([^<]*)<\/title>/.exec(template)?.[1] ?? fallback;
}

/** The component names a template or component imports, as the runtime reads them. */
function importsOf(html: string): string[] {
  const names: string[] = [];
  for (const tag of html.match(/<dc-import\b[^>]*>/g) ?? []) {
    const name = /\s(?:name|component)="([^"]*)"/.exec(tag)?.[1];
    names.push(name ?? "");
  }
  return names;
}

/**
 * The components a page imports, by the path the runtime asks for
 * (`./X.dc.html`), with their sources, following imports inside them;
 * `null` when one is not carried in the page's own manifest, so the page
 * needs another to render.
 */
function componentsOf(inner: Bundle): Map<string, string> | null {
  const uuids = new Map(inner.resources.map((r) => [r.id, r.uuid]));
  const found = new Map<string, string>();
  const pending = importsOf(inner.template);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (!SAFE_STEM.test(name)) return null;
    const path = `./${name}.dc.html`;
    if (found.has(path)) continue;
    const uuid = uuids.get(path);
    const asset = uuid === undefined ? undefined : inner.manifest[uuid];
    if (asset === undefined) return null;
    const source = assetText(asset);
    found.set(path, source);
    pending.push(...importsOf(source));
  }
  return found;
}

/**
 * The page's template with its manifest references resolved: a React build
 * is kept for `vendor/`, the runtime is kept to be inlined, and the script
 * tag that named it is dropped. Two pages carrying different builds of the
 * same file, or different runtimes, are refused.
 */
function resolveAssets(
  title: string,
  template: string,
  manifest: Record<string, Asset>,
  shared: Shared,
): string {
  let html = template;
  for (const [uuid, asset] of Object.entries(manifest)) {
    const text = assetText(asset);
    const react = reactFile(text);
    if (react !== undefined) {
      const earlier = shared.react.get(react);
      if (earlier !== undefined && earlier !== text)
        throw new UnpackError(
          `${title}: its ${react} differs from an earlier page's`,
        );
      shared.react.set(react, text);
      continue;
    }
    const tag = new RegExp(`\\s*<script src="${uuid}"></script>`);
    if (!tag.test(html)) continue;
    if (shared.runtime !== null && shared.runtime !== text)
      throw new UnpackError(
        `${title}: its page runtime differs from an earlier page's`,
      );
    shared.runtime = text;
    html = html.replace(tag, "");
  }
  if (/<script src="[0-9a-f-]{36}"/.test(html))
    throw new UnpackError(
      `${title}: a manifest reference survived the unpacking`,
    );
  return html;
}

const VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

/** The page with a viewport declaration in its head, so a phone lays it out at its own width. */
function withViewport(title: string, html: string): string {
  if (/<meta\s[^>]*name=["']viewport["']/i.test(html)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head === null) throw new UnpackError(`${title}: no <head>`);
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n${VIEWPORT}${html.slice(at)}`;
}

/**
 * The page with its `<x-dc>` block inside an inert `<template
 * data-dc-source>`, which the scenario hook hands to the runtime. The block
 * ends at the template's last `</x-dc>`, as the runtime reads it.
 */
function withInertTemplate(title: string, html: string): string {
  const open = /<x-dc(?:\s[^>]*)?>/.exec(html);
  const close = html.lastIndexOf("</x-dc>");
  if (open === null || close < open.index)
    throw new UnpackError(`${title}: no <x-dc> block`);
  const end = close + "</x-dc>".length;
  return `${html.slice(0, open.index)}<template data-dc-source>${html.slice(open.index, end)}</template>${html.slice(end)}`;
}

/** The page with the scripts it needs appended to its body. */
function withScripts(
  title: string,
  html: string,
  runtime: string | null,
  components: Map<string, string>,
): string {
  const end = html.lastIndexOf("</body>");
  if (end === -1) throw new UnpackError(`${title}: no </body>`);
  if (runtime === null)
    throw new UnpackError(`${title}: names no page runtime in its manifest`);
  return `${html.slice(0, end)}${scripts(runtime, components)}${html.slice(end)}`;
}

/** A file name that cannot leave the directory it is written to. */
const SAFE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Add one page's file to `files`; a page that imports a component it does not carry is skipped. */
function unpackPage(
  id: string,
  page: Asset,
  shared: Shared,
  files: Map<string, string>,
  out: Unpacked,
): void {
  const inner = parseBundle(assetText(page));
  if (inner === null) return;
  const title = titleOf(inner.template, id);
  const components = componentsOf(inner);
  if (!inner.template.includes("<x-dc") || components === null) {
    out.skipped.push(title);
    return;
  }
  const resolved = resolveAssets(title, inner.template, inner.manifest, shared);
  const html = withScripts(
    title,
    withInertTemplate(title, withViewport(title, resolved)),
    shared.runtime,
    components,
  );
  const stem = slug(title) || id;
  if (!SAFE_STEM.test(stem))
    throw new UnpackError(`${title}: its page id is not a plain file name`);
  const name = `${stem}.html`;
  if (out.pages.some((page) => page.toLowerCase() === name.toLowerCase()))
    throw new UnpackError(`${title}: another page is already named ${name}`);
  files.set(`generated/${name}`, html);
  out.pages.push(name);
}

/** An addendum export beside `export.html`: `export-<name>.html`. */
const ADDENDUM = /^export-[A-Za-z0-9][A-Za-z0-9_-]*\.html$/;

/** The bundle's exports, `export.html` first, then each addendum in name order. */
export function exportsOf(dir: string): string[] {
  const main = join(dir, "export.html");
  if (!existsSync(main)) throw new UnpackError(`${main} does not exist`);
  const addenda = readdirSync(dir)
    .filter((name) => ADDENDUM.test(name))
    .sort();
  return [main, ...addenda.map((name) => join(dir, name))];
}

/** Add one export's self-standing pages to `files`. */
function unpackExport(
  exportPath: string,
  shared: Shared,
  files: Map<string, string>,
  out: Unpacked,
): void {
  const outer = parseBundle(readFileSync(exportPath, "utf8"));
  if (outer === null)
    throw new UnpackError(`${exportPath} is not a design export`);
  const before = out.pages.length;
  for (const id of outer.pageOrder) {
    const page = outer.manifest[id];
    if (page === undefined)
      throw new UnpackError(
        `${exportPath} lists page ${id} but does not carry it`,
      );
    unpackPage(id, page, shared, files, out);
  }
  if (out.pages.length === before)
    throw new UnpackError(`${exportPath} holds no self-standing page`);
}

/** Every file the exports yield, by path under the bundle directory; nothing is written. */
export function build(dir: string): {
  files: Map<string, string>;
  out: Unpacked;
} {
  const exports = exportsOf(dir);
  const shared: Shared = { runtime: null, react: new Map() };
  const files = new Map<string, string>();
  const out: Unpacked = { pages: [], skipped: [], react: [] };
  for (const exportPath of exports)
    unpackExport(exportPath, shared, files, out);
  for (const name of REACT_FILES) {
    const text = shared.react.get(name);
    if (text === undefined)
      throw new UnpackError(`${exports.join(", ")}: carries no ${name}`);
    files.set(`vendor/${name}`, text);
    out.react.push(name);
  }
  return { files, out };
}

/**
 * Write the export's self-standing pages, runtime and React builds under
 * `dir`. The whole result is built and checked first, so a refused export
 * leaves the previous output as it was.
 */
export function unpack(dir: string): Unpacked {
  const { files, out } = build(dir);
  rmSync(join(dir, "generated"), { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return out;
}

/** The generated files that differ from what the export yields: missing, changed or left over. */
export function stale(dir: string): string[] {
  const { files } = build(dir);
  const found: string[] = [];
  for (const [path, text] of files) {
    const file = join(dir, path);
    if (!existsSync(file) || readFileSync(file, "utf8") !== text)
      found.push(path);
  }
  const generated = join(dir, "generated");
  if (existsSync(generated))
    for (const name of readdirSync(generated))
      if (!files.has(`generated/${name}`)) found.push(`generated/${name}`);
  return found;
}

const USAGE = "Usage: bun tools/design/unpack-export.ts [--check] <bundle-dir>";

function main(args: string[]): number {
  const check = args[0] === "--check";
  const dir = check ? args[1] : args[0];
  if (dir === undefined || dir.startsWith("-")) throw new UnpackError(USAGE);
  if (check) {
    const found = stale(dir);
    for (const path of found)
      console.error(`${path} differs from a fresh unpacking`);
    if (found.length > 0)
      console.error(
        `regenerate with: bun tools/design/unpack-export.ts ${dir}`,
      );
    return found.length > 0 ? 1 : 0;
  }
  const result = unpack(dir);
  for (const page of result.pages) console.log(`generated/${page}`);
  for (const file of result.react) console.log(`vendor/${file}`);
  for (const title of result.skipped)
    console.log(`skipped (imports another page): ${title}`);
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
