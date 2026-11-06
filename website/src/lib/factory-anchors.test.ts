import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFactory } from "./data/factory.ts";
import {
  forwardHref,
  movedFactoryAnchors,
  RENAMED_PAGES,
} from "./factory-anchors.ts";
import { NAV } from "./site.ts";

const pagesDir = join(import.meta.dir, "../pages/factory");
const repoRoot = join(import.meta.dir, "../../..");

const pageFile = (page: string) =>
  join(pagesDir, page === "" ? "index.astro" : `${page}.astro`);

/** A factory page's own source and that of every component it imports, transitively. */
function renderedSource(page: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const read = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    parts.push(source);
    for (const m of source.matchAll(/^import \w+ from "(\.[^"]+\.astro)";$/gm))
      read(resolve(dirname(file), m[1] ?? ""));
  };
  read(pageFile(page));
  return parts.join("\n");
}

/** Whether a source renders the anchor: a literal `id`, or a job row's `job-<id>`. */
function renders(source: string, id: string): boolean {
  if (id.startsWith("job-")) return /id=\{`job-\$\{j\.id\}`\}/.test(source);
  return source.includes(`id="${id}"`);
}

describe("movedFactoryAnchors", () => {
  const jobIds = parseFactory(
    readFileSync(join(repoRoot, "FACTORY.md"), "utf8"),
  ).jobs.map((j) => j.id);
  const moved = movedFactoryAnchors(jobIds);

  test("every moved anchor is rendered where it lands, and its old name not by the overview", () => {
    const overview = renderedSource("");
    for (const [id, to] of Object.entries(moved)) {
      expect({
        id,
        onPage: renders(renderedSource(to.page), to.anchor),
      }).toEqual({ id, onPage: true });
      expect({ id, onOverview: renders(overview, id) }).toEqual({
        id,
        onOverview: false,
      });
    }
  });

  test("covers the anchors that moved with the scaffolding section and the line", () => {
    expect(moved["trk-cap"]?.page).toBe("scaffolding");
    expect(moved.fitted?.page).toBe("scaffolding");
    for (const id of jobIds)
      expect(moved[`job-${id}`]?.page).toBe("scaffolding");
    expect(moved.execution).toEqual({ page: "line", anchor: "line" });
    expect(forwardHref(moved.execution ?? { page: "", anchor: "" })).toBe(
      "/factory/line/#line",
    );
    expect(moved["execution-level"]).toEqual({
      page: "",
      anchor: "line-level",
    });
  });

  test("names nothing for a fragment that is not a moved anchor", () => {
    for (const id of ["constructor", "toString", "__proto__", "learning", ""]) {
      expect(Object.hasOwn(moved, id)).toBe(false);
    }
  });
});

describe("RENAMED_PAGES", () => {
  test("an old page forwards, and the page it names renders every anchor it had", () => {
    for (const [old, { to, anchors }] of Object.entries(RENAMED_PAGES)) {
      const forward = readFileSync(pageFile(old), "utf8");
      expect(forward).toContain("RENAMED_PAGES");
      expect(forward).not.toMatch(/\bid="/);
      const target = renderedSource(to);
      for (const anchor of Object.values(anchors))
        expect({ anchor, onPage: renders(target, anchor) }).toEqual({
          anchor,
          onPage: true,
        });
      // The rows and stations keep their names on the new page: the row
      // ids (`line-bN`) and the station ids (`station-bN`) the old page had.
      expect(target).toMatch(/id=\{`line-\$\{s\.id\}`\}/);
      expect(target).toMatch(/`station-\$\{station\.id\}`/);
    }
  });

  test("the navigation lists the new page and never the old one", () => {
    const factory = NAV.find((n) => n.href === "/factory/");
    const hrefs = factory?.pages?.map((p) => p.href) ?? [];
    for (const [old, { to }] of Object.entries(RENAMED_PAGES)) {
      expect(hrefs).toContain(`/factory/${to}/`);
      expect(hrefs).not.toContain(`/factory/${old}/`);
    }
    for (const href of hrefs)
      expect({
        href,
        page: existsSync(pageFile(href.replace(/^\/factory\/|\/$/g, ""))),
      }).toEqual({ href, page: true });
  });
});
