/**
 * The whole-changelog check run the way a plugin cache holds it: copied
 * outside this repository, invoked in a configured scratch consumer
 * repository with a tagged release, so its parsing, rules and report are
 * exercised outside the Jig checkout.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { writeWorkingArtifact } from "./artifact.ts";

const root = resolve(import.meta.dirname, "../..");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !["JIG_OVERLAY", "JIG_CONSUMER_ROOT"].includes(key),
  ),
);

let scratch: string;
beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-lint-copy-")));
  writeWorkingArtifact(root, join(scratch, "artifact"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const changelog = (date: string): string =>
  `# Changelog\n\nThis project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n## [Unreleased]\n\n## [1.0.0] - ${date}\n\n### Added\n\n- The first release.\n\n[unreleased]: https://example.com/o/r/compare/v1.0.0...HEAD\n[1.0.0]: https://example.com/o/r/releases/tag/v1.0.0\n`;

test("the whole-changelog check runs from the plugin cache on a configured repository", () => {
  const consumer = join(scratch, "consumer");
  mkdirSync(join(consumer, ".config"), { recursive: true });
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    "changelog:\n  file: CHANGELOG.md\n",
  );
  writeFileSync(join(consumer, "package.json"), '{"version":"1.0.0"}\n');
  writeFileSync(join(consumer, "CHANGELOG.md"), changelog("2026-01-01"));
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      ["-C", consumer, "-c", "user.name=t", "-c", "user.email=t@e", ...args],
      { env },
    );
    expectSpawnExit({ ...result, exitCode: result.status }, 0);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "the first release");
  git("tag", "v1.0.0");
  const script = join(
    scratch,
    "artifact",
    "plugin",
    "skills",
    "changelog",
    "scripts",
    "lint.ts",
  );
  const lint = () =>
    spawnSync(process.execPath, [script, "--json"], { cwd: consumer, env });
  const clean = lint();
  expectSpawnExit({ ...clean, exitCode: clean.status }, 0);
  expect(JSON.parse(clean.stdout)).toMatchObject({
    configured: true,
    format: "keep-a-changelog",
    findings: [],
    unchecked: null,
  });
  writeFileSync(join(consumer, "CHANGELOG.md"), changelog("2026-02-30"));
  const invalid = lint();
  expectSpawnExit({ ...invalid, exitCode: invalid.status }, 1);
  expect(
    JSON.parse(invalid.stdout).findings.map(
      (f: { rule: string; line: number }) => `${f.rule}:${f.line}`,
    ),
  ).toEqual(["keep-a-changelog/date:7"]);
});
