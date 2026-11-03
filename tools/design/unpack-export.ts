#!/usr/bin/env bun
/**
 * Unpack a design round's export into pages a browser renders on its own.
 *
 * The design tool exports one self-extracting HTML file: a board of nested
 * pages, each a gzip-compressed, base64-encoded document in a manifest, each
 * loading the tool's page runtime and React from the same manifest at run
 * time. Nothing in it renders without that unpacker, and the landing check
 * (`design-brief-builder`) refuses frames and network requests, so this
 * script writes, beside the export:
 *
 * - `generated/<title-slug>.html` for every page that stands on its own
 *   (holds an `<x-dc>` template and imports no other page), with the
 *   runtime's manifest reference replaced by three scripts at the end of
 *   its body: the scenario hook below, inline; the React builds, by path;
 *   and the page runtime as exported, inline;
 * - `vendor/react.production.min.js` and `vendor/react-dom.production.min.js`,
 *   the React builds as exported (their licence stays in `vendor/LICENSE`).
 *
 * The scenario hook, which is not part of the design, reads `?scenario=`,
 * `?theme=` and `?switch=off` from the URL into the page's props before the
 * runtime boots, and marks the document ready (`html[data-scenario-ready]`)
 * once the page has rendered, so the landing check opens one scenario per
 * URL and waits for it.
 *
 * Usage: `bun tools/design/unpack-export.ts <bundle-dir>`, where the bundle
 * holds `export.html`. `generated/` is replaced whole. Exit 2 when the file
 * is not such an export.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

interface Bundle {
  manifest: Record<string, Asset>;
  template: string;
  pageOrder: string[];
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

/** The bundle a self-extracting document carries; `null` when it carries none. */
export function parseBundle(html: string): Bundle | null {
  const manifest = section(html, "manifest");
  const template = section(html, "template");
  if (manifest === null || template === null) return null;
  const order = section(html, "page_order");
  return {
    manifest: decodeJson(manifest, isManifest, "the export's manifest"),
    template: decodeJson(template, isString, "the export's template"),
    pageOrder:
      order === null
        ? []
        : decodeJson(order, isStringArray, "the export's page order"),
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

/** The scenario hook, inlined into every generated page before the runtime. */
const HOOK = `(function () {
  var query = new URLSearchParams(location.search);
  var script = document.querySelector("script[data-dc-script]");
  if (script) {
    try {
      var props = JSON.parse(script.getAttribute("data-props") || "{}");
      ["scenario", "theme"].forEach(function (name) {
        var value = query.get(name);
        var prop = props[name];
        if (value && prop && (!prop.options || prop.options.indexOf(value) >= 0))
          prop.default = value;
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

/** The scripts a generated page ends its body with. */
function scripts(runtime: string): string {
  return `<script>
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

/** What the pages share: the one runtime, inlined into each, and the React builds, written once. */
interface Shared {
  vendor: string;
  runtime: string | null;
  react: string[];
}

/** A page's title, for its file name and its messages. */
function titleOf(template: string, fallback: string): string {
  return /<title>([^<]*)<\/title>/.exec(template)?.[1] ?? fallback;
}

/** Whether a page renders on its own: it holds a template and imports no other page. */
function standsAlone(template: string): boolean {
  return template.includes("<x-dc") && !template.includes("<dc-import");
}

/**
 * The page's template with its manifest references resolved: a React build
 * goes to `vendor/`, the runtime is kept for `support.js`, and the script tag
 * that named it is dropped.
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
      writeFileSync(join(shared.vendor, react), text);
      if (!shared.react.includes(react)) shared.react.push(react);
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

/** The page with the scripts it needs appended to its body. */
function withScripts(
  title: string,
  html: string,
  runtime: string | null,
): string {
  const end = html.lastIndexOf("</body>");
  if (end === -1) throw new UnpackError(`${title}: no </body>`);
  if (runtime === null)
    throw new UnpackError(`${title}: names no page runtime in its manifest`);
  return `${html.slice(0, end)}${scripts(runtime)}${html.slice(end)}`;
}

/** Write one page under `generated`; its file name, or `null` when it was skipped. */
function unpackPage(
  id: string,
  page: Asset,
  generated: string,
  shared: Shared,
  out: Unpacked,
): void {
  const inner = parseBundle(assetText(page));
  if (inner === null) return;
  const title = titleOf(inner.template, id);
  if (!standsAlone(inner.template)) {
    out.skipped.push(title);
    return;
  }
  const resolved = resolveAssets(title, inner.template, inner.manifest, shared);
  const html = withScripts(title, resolved, shared.runtime);
  const name = `${slug(title) || id}.html`;
  writeFileSync(join(generated, name), html);
  out.pages.push(name);
}

/** Write the export's self-standing pages, runtime and React builds under `dir`. */
export function unpack(dir: string): Unpacked {
  const exportPath = join(dir, "export.html");
  if (!existsSync(exportPath))
    throw new UnpackError(`${exportPath} does not exist`);
  const outer = parseBundle(readFileSync(exportPath, "utf8"));
  if (outer === null)
    throw new UnpackError(`${exportPath} is not a design export`);
  const generated = join(dir, "generated");
  rmSync(generated, { recursive: true, force: true });
  mkdirSync(generated, { recursive: true });
  const shared: Shared = {
    vendor: join(dir, "vendor"),
    runtime: null,
    react: [],
  };
  mkdirSync(shared.vendor, { recursive: true });
  const out: Unpacked = { pages: [], skipped: [], react: [] };
  for (const id of outer.pageOrder) {
    const page = outer.manifest[id];
    if (page !== undefined) unpackPage(id, page, generated, shared, out);
  }
  out.react = shared.react;
  if (out.pages.length === 0)
    throw new UnpackError(`${exportPath} holds no self-standing page`);
  return out;
}

const USAGE = "Usage: bun tools/design/unpack-export.ts <bundle-dir>";

function main(args: string[]): number {
  const dir = args[0];
  if (dir === undefined || dir.startsWith("-")) throw new UnpackError(USAGE);
  const result = unpack(dir);
  for (const page of result.pages) console.log(`generated/${page}`);
  for (const file of result.react) console.log(`vendor/${file}`);
  for (const title of result.skipped)
    console.log(`skipped (imports another page): ${title}`);
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
