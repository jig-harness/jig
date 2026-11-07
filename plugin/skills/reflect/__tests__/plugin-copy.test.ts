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
import {
  buildReport,
  type MergeRecord,
} from "../../resolve-conflicts/scripts/lib/report.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { finding, Machine, type Run } from "./scratch.ts";

/** A clean success: exit 0, its output shown if not, and nothing on stderr. */
function succeeded(r: Run, what: string): void {
  expectSpawnExit(
    { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
    0,
    what,
  );
  expect(r.stderr).toBe("");
}

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
  succeeded(noted, "journal.ts note");
  const id = (JSON.parse(noted.stdout) as { id: string }).id;

  const contributed = repo.script(
    "reflect.ts",
    ["contribute"],
    undefined,
    reflect,
  );
  expectSpawnExit(
    {
      exitCode: contributed.code,
      stdout: contributed.stdout,
      stderr: contributed.stderr,
    },
    0,
    "reflect.ts contribute",
  );
  const stored = JSON.parse(contributed.stdout) as {
    stored: Array<{ id: string }>;
  };
  expect(stored.stored.map((s) => s.id)).toEqual([id]);

  const loaded = repo.script("review.ts", ["load"], undefined, review);
  expectSpawnExit(
    { exitCode: loaded.code, stdout: loaded.stdout, stderr: loaded.stderr },
    0,
    "review.ts load",
  );
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
  // Four merges that each met an append conflict in the changelog.
  const merges = [1, 2, 3, 4].map(
    (n) =>
      ({
        operation: "merge",
        commit: `${n}`.repeat(40),
        parents: ["a".repeat(40), "b".repeat(40)],
        date: `2026-01-0${n}T03:04:05+00:00`,
        subject: `Merge branch 'feature-${n}'`,
        pullRequest: null,
        branches: { from: `feature-${n}`, into: null },
        parentHeads: { ours: [], theirs: [] },
        conflicted: true,
        mechanical: false,
        paths: [
          {
            path: "CHANGELOG.md",
            kind: null,
            conflicts: ["contents"],
            class: "text",
            causes: ["append"],
            regions: [],
            mechanical: false,
            resolution: null,
          },
        ],
        unmatchedResolutions: [],
      }) as unknown as MergeRecord,
  );
  writeFileSync(
    report,
    JSON.stringify(
      buildReport({
        range: { since: null, until: null, label: "all history" },
        hotspotMinMerges: 3,
        merges,
        skipped: [],
        confidence: null,
      }),
    ),
  );
  const noted = repo.script(
    "reflect.ts",
    ["hotspots", report],
    undefined,
    reflect,
  );
  succeeded(noted, "reflect.ts hotspots");
  const out = JSON.parse(noted.stdout) as {
    hotspots: Array<{ class: string; action: string }>;
  };
  expect(out.hotspots).toMatchObject([{ class: "append", action: "noted" }]);
});
