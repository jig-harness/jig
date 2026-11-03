/**
 * `tools/design/unpack-export.ts` over a synthetic export: a self-standing
 * page comes out with its runtime reference replaced by the hook, the React
 * script tags and the runtime inline, a page that imports another is
 * skipped, the React builds are written beside it, and a file that is not an
 * export is refused.
 */
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";

const SCRIPT = resolve(import.meta.dir, "unpack-export.ts");
const RUNTIME_ID = "11111111-1111-4111-8111-111111111111";
const REACT_ID = "22222222-2222-4222-8222-222222222222";
const DOM_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const IMPORTER_ID = "55555555-5555-4555-8555-555555555555";

function asset(text: string, mime = "text/javascript") {
  return {
    mime,
    compressed: true,
    data: Buffer.from(Bun.gzipSync(Buffer.from(text))).toString("base64"),
  };
}

function bundle(
  template: string,
  manifest: Record<string, unknown>,
  pageOrder?: string[],
): string {
  const order =
    pageOrder === undefined
      ? ""
      : `<script type="__bundler/page_order">${JSON.stringify(pageOrder)}</script>`;
  // The export escapes `</` inside its JSON as `<\/`, so a template holding
  // `</script>` does not end the script element that carries it.
  const json = (value: unknown) =>
    JSON.stringify(value).replace(/<\//g, "<\\/");
  return `<!doctype html><html><body>
<script type="__bundler/manifest">${json(manifest)}</script>
<script type="__bundler/template">${json(template)}</script>
${order}</body></html>`;
}

const RUNTIME = '"use strict";window.__runtime="</script><!--<script>";';
const REACT =
  "/**\n * @license React\n * react.production.min.js\n */\nwindow.React={};";
const DOM =
  "/**\n * @license React\n * react-dom.production.min.js\n */\nwindow.ReactDOM={};";

function pageTemplate(title: string, body: string): string {
  return `<!DOCTYPE html>\n<html lang="en"><head>\n<title>${title}</title>\n<script src="${RUNTIME_ID}"></script>\n</head>\n<body>\n${body}\n<script type="text/x-dc" data-dc-script="" data-props="{}">class Component {}</script>\n</body></html>`;
}

function syntheticExport(): string {
  const page = bundle(
    pageTemplate("Sample page", '<x-dc><div class="dd">hello</div></x-dc>'),
    {
      [RUNTIME_ID]: asset(RUNTIME),
      [REACT_ID]: asset(REACT),
      [DOM_ID]: asset(DOM),
    },
  );
  const importer = bundle(
    pageTemplate(
      "Sample page, phone",
      '<x-dc><dc-import name="Main"></dc-import></x-dc>',
    ),
    { [RUNTIME_ID]: asset(RUNTIME) },
  );
  return bundle(
    `<html><body><iframe src="about:blank#${PAGE_ID}"></iframe></body></html>`,
    {
      [PAGE_ID]: asset(page, "text/html"),
      [IMPORTER_ID]: asset(importer, "text/html"),
    },
    [PAGE_ID, IMPORTER_ID],
  );
}

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the script over a directory holding `export.html` with `html`; the directory is removed after `check`. */
function withExport(
  html: string,
  check: (dir: string, result: Run) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "unpack-export-"));
  try {
    writeFileSync(join(dir, "export.html"), html);
    const result = Bun.spawnSync(["bun", SCRIPT, dir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    check(dir, {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const read = (dir: string, ...path: string[]) =>
  readFileSync(join(dir, ...path), "utf8");

describe("unpack-export", () => {
  it("writes the self-standing page with its scripts and skips an importing page", () => {
    withExport(syntheticExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      expect(result.stdout).toContain("generated/sample-page.html");
      expect(result.stdout).toContain(
        "skipped (imports another page): Sample page, phone",
      );
      const html = read(dir, "generated", "sample-page.html");
      expect(html).not.toContain(RUNTIME_ID);
      expect(html).toContain("data-scenario-ready");
      expect(html).toContain(
        '<script src="../vendor/react.production.min.js"></script>',
      );
      expect(html).toContain(
        '"use strict";window.__runtime="<\\/script><\\!--<script>";\n</script>\n</body>',
      );
      expect(html).toContain('<div class="dd">hello</div>');
      expect(existsSync(join(dir, "generated", "sample-page-phone.html"))).toBe(
        false,
      );
    });
  });

  it("writes the React builds beside the pages and keeps a closing tag inside the runtime inert", () => {
    withExport(syntheticExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      expect(existsSync(join(dir, "generated", "support.js"))).toBe(false);
      const html = read(dir, "generated", "sample-page.html");
      expect(html).toContain('"<\\/script><\\!--<script>"');
      expect(html).not.toContain('"</script>');
      expect(html).not.toContain("<!--");
      expect(read(dir, "vendor", "react.production.min.js")).toBe(REACT);
      expect(read(dir, "vendor", "react-dom.production.min.js")).toBe(DOM);
    });
  });

  it("refuses a file that is not an export", () => {
    withExport(
      "<!doctype html><html><body>plain</body></html>",
      (dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain("is not a design export");
        expect(existsSync(join(dir, "generated"))).toBe(false);
      },
    );
  });
});
