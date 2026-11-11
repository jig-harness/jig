/**
 * `tools/design/unpack-export.ts` over a synthetic export: a self-standing
 * page comes out with its runtime reference replaced by the hook, the React
 * script tags and the runtime inline, the components a page imports from its
 * own manifest are inlined for the runtime to read, a page that imports
 * another page or a component it does not carry is skipped, the React builds
 * are written beside it, and a file that is not an export is refused.
 */
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
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
  resources?: { id: string; uuid: string }[],
): string {
  const order =
    pageOrder === undefined
      ? ""
      : `<script type="__bundler/page_order">${JSON.stringify(pageOrder)}</script>`;
  // The export escapes `</` inside its JSON as `<\/`, so a template holding
  // `</script>` does not end the script element that carries it.
  const json = (value: unknown) =>
    JSON.stringify(value).replace(/<\//g, "<\\/");
  const ext =
    resources === undefined
      ? ""
      : `<script type="__bundler/ext_resources">${json(resources)}</script>`;
  return `<!doctype html><html><body>
<script type="__bundler/manifest">${json(manifest)}</script>
<script type="__bundler/template">${json(template)}</script>
${order}${ext}</body></html>`;
}

const RUNTIME = '"use strict";window.__runtime="</script><!--<script>";';
const REACT =
  "/**\n * @license React\n * react.production.min.js\n */\nwindow.React={};";
const DOM =
  "/**\n * @license React\n * react-dom.production.min.js\n */\nwindow.ReactDOM={};";

function pageTemplate(title: string, body: string): string {
  return `<!DOCTYPE html>\n<html lang="en"><head>\n<title>${title}</title>\n<script src="${RUNTIME_ID}"></script>\n</head>\n<body>\n${body}\n<script type="text/x-dc" data-dc-script="" data-props="{}">class Component {}</script>\n</body></html>`;
}

interface PageSpec {
  id: string;
  title: string;
  react?: string;
  dom?: string | null;
}

/** An export of self-standing pages, each carrying its own React builds. */
function pagesExport(pages: PageSpec[]): string {
  const manifest: Record<string, unknown> = {};
  for (const spec of pages) {
    const assets: Record<string, unknown> = {
      [RUNTIME_ID]: asset(RUNTIME),
      [REACT_ID]: asset(spec.react ?? REACT),
    };
    if (spec.dom !== null) assets[DOM_ID] = asset(spec.dom ?? DOM);
    manifest[spec.id] = asset(
      bundle(pageTemplate(spec.title, "<x-dc><div>hello</div></x-dc>"), assets),
      "text/html",
    );
  }
  return bundle(
    "<html><body></body></html>",
    manifest,
    pages.map((spec) => spec.id),
  );
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

const IDENT_ID = "66666666-6666-4666-8666-666666666666";
const MARK_ID = "77777777-7777-4777-8777-777777777777";
const HALF_ID = "88888888-8888-4888-8888-888888888888";
const IDENT =
  '<!doctype html>\n<html><head><title>Work identity</title></head><body><x-dc><b>ident</b><dc-import name="Mark"></dc-import><script>"</script>"</script></x-dc></body></html>';
const MARK =
  "<!doctype html>\n<html><head><title>Mark</title></head><body><x-dc><i>mark</i></x-dc></body></html>";

/**
 * An export whose pages import components (`<dc-import>`), the way the
 * design tool carries them: in the page's own manifest, mapped from the
 * path the runtime asks for by the page's `ext_resources`. One page carries
 * everything it imports, one draws another page carried as a component, one
 * lacks a component its component imports.
 */
function componentsExport(): string {
  const shared = {
    [RUNTIME_ID]: asset(RUNTIME),
    [REACT_ID]: asset(REACT),
    [DOM_ID]: asset(DOM),
  };
  const cards = bundle(
    pageTemplate(
      "Cards page",
      '<x-dc><div class="dd"><dc-import name="Ident" w="{{r.ident}}" hint-size="120px,28px"></dc-import></div></x-dc>',
    ),
    {
      ...shared,
      [IDENT_ID]: asset(IDENT, "text/html"),
      [MARK_ID]: asset(MARK, "text/html"),
    },
    undefined,
    [
      { id: "./Ident.dc.html", uuid: IDENT_ID },
      { id: "./Mark.dc.html", uuid: MARK_ID },
    ],
  );
  const phone = bundle(
    pageTemplate(
      "Cards page, phone",
      '<x-dc><dc-import name="Cards"></dc-import></x-dc>',
    ),
    {
      ...shared,
      [MARK_ID]: asset(
        "<!doctype html>\n<html><head><title>Cards page</title></head><body><x-dc>cards</x-dc></body></html>",
        "text/html",
      ),
    },
    undefined,
    [{ id: "./Cards.dc.html", uuid: MARK_ID }],
  );
  const half = bundle(
    pageTemplate(
      "Half page",
      '<x-dc><dc-import name="Ident"></dc-import></x-dc>',
    ),
    { ...shared, [IDENT_ID]: asset(IDENT, "text/html") },
    undefined,
    [{ id: "./Ident.dc.html", uuid: IDENT_ID }],
  );
  return bundle(
    "<html><body></body></html>",
    {
      [PAGE_ID]: asset(cards, "text/html"),
      [IMPORTER_ID]: asset(phone, "text/html"),
      [HALF_ID]: asset(half, "text/html"),
    },
    [PAGE_ID, IMPORTER_ID, HALF_ID],
  );
}

/** The body of the inline script that follows `marker` in `html`. */
function scriptAfter(html: string, marker: string): string {
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const body = start + marker.length;
  return html.slice(body, html.indexOf("</script>", body));
}

/** Run a generated page's scenario hook over fakes of the browser globals it reads; returns its `window`. */
function runHook(
  html: string,
  search: string,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const window: Record<string, unknown> = {};
  new Function(
    "window",
    "location",
    "document",
    scriptAfter(
      html,
      "/* Landing-check hook, not part of the design (tools/design/unpack-export.ts). */\n",
    ),
  )(window, { search }, document);
  return window;
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
  args: string[] = [],
  before?: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "unpack-export-"));
  try {
    writeFileSync(join(dir, "export.html"), html);
    before?.(dir);
    const result = Bun.spawnSync(["bun", SCRIPT, ...args, dir], {
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

  it("inlines the components a page carries and skips one that imports a missing component", async () => {
    let html = "";
    let phone = "";
    withExport(componentsExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      expect(result.stdout).toContain("generated/cards-page.html");
      expect(result.stdout).toContain("generated/cards-page-phone.html");
      expect(result.stdout).toContain(
        "skipped (imports another page): Half page",
      );
      html = read(dir, "generated", "cards-page.html");
      phone = read(dir, "generated", "cards-page-phone.html");
    });
    expect(phone).toContain('"./Cards.dc.html"');
    expect(html).not.toContain(IDENT_ID);
    expect(html).not.toContain('"</script>"');
    const marker =
      "/* The components this page imports, as exported, for the runtime to read. */\n";
    expect(html.indexOf(marker)).toBeLessThan(
      html.indexOf("/* Landing-check hook"),
    );
    const window: Record<string, Record<string, unknown>> = {};
    new Function("window", scriptAfter(html, marker))(window);
    const resources = window.__resources as Record<string, string>;
    const blobs = window.__resourceBlobs as Record<string, Blob>;
    expect(Object.keys(resources).sort()).toEqual([
      "./Ident.dc.html",
      "./Mark.dc.html",
    ]);
    expect(await blobs[resources["./Ident.dc.html"] as string]?.text()).toBe(
      IDENT,
    );
    expect(await blobs[resources["./Mark.dc.html"] as string]?.text()).toBe(
      MARK,
    );
  });

  it("unpacks each addendum export beside export.html into the same pages", () => {
    withExport(
      syntheticExport(),
      (dir, result) => {
        expectSpawnExit(result, 0);
        expect(result.stdout).toContain("generated/sample-page.html");
        expect(result.stdout).toContain("generated/addendum-page.html");
        expect(read(dir, "generated", "addendum-page.html")).toContain(
          "data-scenario-ready",
        );
        expect(existsSync(join(dir, "generated", "ignored-page.html"))).toBe(
          false,
        );
      },
      [],
      (dir) => {
        writeFileSync(
          join(dir, "export-2b.html"),
          pagesExport([{ id: HALF_ID, title: "Addendum page" }]),
        );
        writeFileSync(
          join(dir, "exported.html"),
          pagesExport([{ id: MARK_ID, title: "Ignored page" }]),
        );
      },
    );
  });

  it("refuses an addendum whose page shares a file name with the main export's", () => {
    withExport(
      syntheticExport(),
      (dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain("already named sample-page.html");
        expect(existsSync(join(dir, "generated"))).toBe(false);
      },
      [],
      (dir) =>
        writeFileSync(
          join(dir, "export-2b.html"),
          pagesExport([{ id: HALF_ID, title: "Sample page" }]),
        ),
    );
  });

  it("reads every listed or boolean prop from the URL, and ?switch=off", () => {
    let html = "";
    withExport(syntheticExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      html = read(dir, "generated", "sample-page.html");
    });
    const props: Record<string, Record<string, unknown>> = {
      scenario: { editor: "enum", default: "loud", options: ["loud", "quiet"] },
      view: { editor: "enum", default: "auto", options: ["auto", "running"] },
      theme: { editor: "enum", default: "system", options: ["light", "dark"] },
      openFirst: { editor: "boolean", default: false },
      showSwitch: { editor: "boolean", default: true },
    };
    let attribute = JSON.stringify(props);
    const marks: string[] = [];
    runHook(
      html,
      "?scenario=quiet&view=running&theme=sepia&openFirst=true&switch=off",
      {
        querySelector: (selector: string) =>
          selector === "script[data-dc-script]"
            ? {
                getAttribute: () => attribute,
                setAttribute: (_: string, value: string) => {
                  attribute = value;
                },
              }
            : null,
        getElementById: () => ({ firstElementChild: {} }),
        documentElement: { setAttribute: (name: string) => marks.push(name) },
      },
    );
    const parsed = JSON.parse(attribute);
    expect(parsed.scenario.default).toBe("quiet");
    expect(parsed.view.default).toBe("running");
    expect(parsed.theme.default).toBe("system");
    expect(parsed.openFirst.default).toBe(true);
    expect(parsed.showSwitch.default).toBe(false);
    expect(marks).toEqual(["data-scenario-ready"]);
  });

  it("carries the template inert and hands it to the runtime as an x-dc element", () => {
    let html = "";
    withExport(syntheticExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      html = read(dir, "generated", "sample-page.html");
    });
    expect(html).toContain(
      '<template data-dc-source><x-dc><div class="dd">hello</div></x-dc></template>',
    );
    const parsedTemplate = {
      attributes: [{ name: "data-x", value: "1" }],
      innerHTML: '<svg><use href="{{r.icon}}"></use></svg>',
    };
    const attributes: Record<string, string> = {};
    const host = {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    } as { setAttribute: (n: string, v: string) => void; innerHTML?: string };
    let replacement: unknown = null;
    const window = runHook(html, "", {
      querySelector: (selector: string) =>
        selector === "template[data-dc-source]"
          ? {
              content: { querySelector: () => parsedTemplate },
              replaceWith: (node: unknown) => {
                replacement = node;
              },
            }
          : null,
      createElement: () => host,
      getElementById: () => ({ firstElementChild: {} }),
      documentElement: { setAttribute: () => undefined },
    });
    expect(replacement).toBe(host);
    expect(host.innerHTML).toBe(parsedTemplate.innerHTML);
    expect(attributes).toEqual({ "data-x": "1" });
    expect(window.__resources).toEqual({});
  });

  it("adds no component script to a page that imports nothing", () => {
    withExport(syntheticExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      expect(read(dir, "generated", "sample-page.html")).not.toContain(
        "__resourceBlobs",
      );
    });
  });

  it("declares a viewport in every generated page", () => {
    withExport(syntheticExport(), (dir, result) => {
      expectSpawnExit(result, 0);
      expect(read(dir, "generated", "sample-page.html")).toContain(
        '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">',
      );
    });
  });

  it("refuses two pages that would share a file name", () => {
    withExport(
      pagesExport([
        { id: PAGE_ID, title: "Sample page" },
        { id: IMPORTER_ID, title: "Sample-page" },
      ]),
      (dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain("already named sample-page.html");
        expect(existsSync(join(dir, "generated"))).toBe(false);
      },
    );
  });

  it("refuses two pages whose file names differ only in case", () => {
    withExport(
      pagesExport([
        { id: PAGE_ID, title: "" },
        { id: IMPORTER_ID, title: "" },
      ])
        .replaceAll(PAGE_ID, "Page")
        .replaceAll(IMPORTER_ID, "page"),
      (dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain("is already named");
        expect(existsSync(join(dir, "generated"))).toBe(false);
      },
    );
  });

  it("refuses a page order that names a page the export does not carry", () => {
    const html = pagesExport([{ id: PAGE_ID, title: "Sample page" }]);
    withExport(
      html.replace(`["${PAGE_ID}"]`, `["${PAGE_ID}","missing-page"]`),
      (_dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain("does not carry it");
      },
    );
  });

  it("refuses a page whose id would leave the directory", () => {
    withExport(pagesExport([{ id: "../export", title: "" }]), (dir, result) => {
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("not a plain file name");
      expect(read(dir, "export.html")).toContain("__bundler/manifest");
    });
  });

  it("refuses an export that lacks a React build", () => {
    withExport(
      pagesExport([{ id: PAGE_ID, title: "Sample page", dom: null }]),
      (_dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain(
          "carries no react-dom.production.min.js",
        );
      },
    );
  });

  it("refuses pages whose React builds differ", () => {
    withExport(
      pagesExport([
        { id: PAGE_ID, title: "First" },
        { id: IMPORTER_ID, title: "Second", react: `${REACT}\n/* other */` },
      ]),
      (_dir, result) => {
        expectSpawnExit(result, 2);
        expect(result.stderr).toContain(
          "its react.production.min.js differs from an earlier page's",
        );
      },
    );
  });

  it("keeps the previous output when the export is refused", () => {
    withExport(
      pagesExport([{ id: PAGE_ID, title: "Sample page", dom: null }]),
      (dir, result) => {
        expectSpawnExit(result, 2);
        expect(read(dir, "generated", "old.html")).toBe("previous");
      },
      [],
      (dir) => {
        mkdirSync(join(dir, "generated"));
        writeFileSync(join(dir, "generated", "old.html"), "previous");
      },
    );
  });

  it("--check passes over fresh output and names what differs otherwise", () => {
    const html = syntheticExport();
    withExport(html, (dir, written) => {
      expectSpawnExit(written, 0);
      const fresh = Bun.spawnSync(["bun", SCRIPT, "--check", dir]);
      expectSpawnExit(
        {
          exitCode: fresh.exitCode,
          stdout: fresh.stdout.toString(),
          stderr: fresh.stderr.toString(),
        },
        0,
      );
      writeFileSync(join(dir, "generated", "sample-page.html"), "edited");
      writeFileSync(join(dir, "generated", "extra.html"), "left over");
      const drifted = Bun.spawnSync(["bun", SCRIPT, "--check", dir]);
      const text = drifted.stderr.toString();
      expectSpawnExit(
        { exitCode: drifted.exitCode, stdout: "", stderr: text },
        1,
      );
      expect(text).toContain("generated/sample-page.html differs");
      expect(text).toContain("generated/extra.html differs");
      expect(text).toContain(
        "regenerate with: bun tools/design/unpack-export.ts",
      );
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
