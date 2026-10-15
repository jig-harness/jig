import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFactory } from "./data/factory.ts";
import { movedFactoryAnchors } from "./factory-anchors.ts";

const pagesDir = join(import.meta.dir, "../pages/factory");
const repoRoot = join(import.meta.dir, "../../..");

/** A factory page's own source and that of every component it imports. */
function renderedSource(page: string): string {
  const file = join(pagesDir, page === "" ? "index.astro" : `${page}.astro`);
  const source = readFileSync(file, "utf8");
  const parts = [source];
  for (const m of source.matchAll(/^import \w+ from "(\.[^"]+\.astro)";$/gm)) {
    parts.push(readFileSync(resolve(dirname(file), m[1] ?? ""), "utf8"));
  }
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

  test("every moved anchor is rendered by its page, and not by the overview", () => {
    const overview = renderedSource("");
    for (const [id, page] of Object.entries(moved)) {
      expect({ id, onPage: renders(renderedSource(page), id) }).toEqual({
        id,
        onPage: true,
      });
      expect({ id, onOverview: renders(overview, id) }).toEqual({
        id,
        onOverview: false,
      });
    }
  });

  test("covers the anchors that moved with the scaffolding section", () => {
    expect(moved["trk-cap"]).toBe("scaffolding");
    expect(moved.fitted).toBe("scaffolding");
    for (const id of jobIds) expect(moved[`job-${id}`]).toBe("scaffolding");
  });

  test("names nothing for a fragment that is not a moved anchor", () => {
    for (const id of ["constructor", "toString", "__proto__", "learning", ""]) {
      expect(Object.hasOwn(moved, id)).toBe(false);
    }
  });
});
