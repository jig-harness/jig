/**
 * The plugin cache holds a copy of the skills outside any repository, with no
 * `node_modules` above it. Capture, contribute and review have to run from
 * such a copy, started from a consumer repository.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { finding, Machine } from "./scratch.ts";

const plugin = join(import.meta.dir, "..", "..", "..");
let cache: string;
let m: Machine;

beforeAll(() => {
  cache = realpathSync(mkdtempSync(join(tmpdir(), "reflect-cache-")));
  cpSync(plugin, join(cache, "plugin"), {
    recursive: true,
    filter: (path) => !path.split(sep).includes("__tests__"),
  });
  m = new Machine();
  m.userConfig();
});
afterAll(() => {
  rmSync(cache, { recursive: true, force: true });
  m.cleanup();
});

it("notes, contributes and reviews from a copy outside this repository", () => {
  for (let dir = cache; dirname(dir) !== dir; dir = dirname(dir))
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  const skills = join(cache, "plugin", "skills");
  const repo = m.repository("web", "git@github.com:example/web.git");
  const reflect = join(skills, "reflect", "scripts");
  const review = join(skills, "review-reflections", "scripts");

  const noted = repo.script(
    "journal.ts",
    ["note"],
    JSON.stringify(finding()),
    reflect,
  );
  expect(noted.stderr).toBe("");
  expect(noted.code).toBe(0);
  const id = (JSON.parse(noted.stdout) as { id: string }).id;

  const contributed = repo.script(
    "reflect.ts",
    ["contribute"],
    undefined,
    reflect,
  );
  expect(contributed.code).toBe(0);
  const stored = JSON.parse(contributed.stdout) as {
    stored: Array<{ id: string }>;
  };
  expect(stored.stored.map((s) => s.id)).toEqual([id]);

  const loaded = repo.script("review.ts", ["load"], undefined, review);
  expect(loaded.code).toBe(0);
  const groups = (
    JSON.parse(loaded.stdout) as {
      groups: Array<{
        findings: Array<{ id: string; session: { jig_version: string } }>;
      }>;
    }
  ).groups;
  expect(groups[0]?.findings[0]?.id).toBe(id);
  expect(groups[0]?.findings[0]?.session.jig_version).toMatch(
    /^\d+\.\d+\.\d+$/,
  );
});

it("notes a conflict hotspot from a copy, reading the cause list by sibling path", () => {
  const reflect = join(cache, "plugin", "skills", "reflect", "scripts");
  const repo = m.repository("api", "git@github.com:example/api.git");
  const report = join(m.dir, "merge-conflicts.json");
  writeFileSync(
    report,
    JSON.stringify({
      schema: "merge-conflicts/v1",
      range: { since: null, until: null, label: "all history" },
      hotspotMinMerges: 3,
      shallow: false,
      totals: { merges: 9 },
      paths: [
        {
          path: "CHANGELOG.md",
          merges: 4,
          causes: { append: 4 },
          topCause: "append",
          remedy: "one file per entry",
          hotspot: true,
          lastConflict: "2026-01-02T03:04:05Z",
        },
      ],
      hotspots: ["CHANGELOG.md"],
      skipped: [],
      confidence: null,
      limits: ["It counts a conflict once for each merge that meets it again."],
    }),
  );
  const noted = repo.script(
    "reflect.ts",
    ["hotspots", report],
    undefined,
    reflect,
  );
  expect(noted.stderr).toBe("");
  expect(noted.code).toBe(0);
  const out = JSON.parse(noted.stdout) as {
    hotspots: Array<{ class: string; action: string }>;
  };
  expect(out.hotspots).toMatchObject([{ class: "append", action: "noted" }]);
});
