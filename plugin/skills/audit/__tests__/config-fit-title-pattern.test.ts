/**
 * The configuration fit judges `pull_requests.title_pattern` against the
 * integration branch's recent commit subjects: with squash merges they are
 * the pull request titles.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { commitFiles, runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONFIG =
  "issue_tracker:\n  adapter: linear\n  team: ENG\npull_requests:\n  title_format: pattern\n  title_pattern: '{key}: {summary}'\n";

/** The fit's findings for a repository with this configuration and these commit subjects after the first. */
function findings(
  config: string,
  subjects: string[],
): { id: string; message: string }[] {
  const dir = scratchRepo({ ".config/jig.yaml": config });
  dirs.push(dir);
  for (const subject of subjects) commitFiles(dir, {}, subject);
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  return (
    JSON.parse(run.out) as { findings: { id: string; message: string }[] }
  ).findings;
}

const CONTRADICTION = "contradiction:pull_requests.title_pattern";

test("subjects that follow the pattern raise nothing", () => {
  const found = findings(CONFIG, [
    "ENG-1: a",
    "ENG-2: b (#9)",
    "ENG-3: c",
    "ENG-4: d",
    "ENG-5: e",
  ]);
  expect(found.map((f) => f.id)).not.toContain(CONTRADICTION);
  expect(found.map((f) => f.id)).not.toContain("unchecked:title-pattern");
});

test("subjects that mostly do not follow the pattern are a warning", () => {
  const found = findings(CONFIG, [
    "feat: a",
    "fix: b",
    "ENG-3: c",
    "chore: d",
    "docs: e",
  ]);
  const finding = found.find((f) => f.id === CONTRADICTION);
  expect(finding?.message).toContain("1 of the last 6 commit subjects");
  expect(finding?.message).toContain('"{key}: {summary}"');
});

test("too little history is reported as unchecked", () => {
  const found = findings(CONFIG, ["ENG-1: a"]);
  expect(found.map((f) => f.id)).toContain("unchecked:title-pattern");
  expect(found.map((f) => f.id)).not.toContain(CONTRADICTION);
});

test("another title format is not judged", () => {
  const found = findings("pull_requests:\n  title_format: free\n", [
    "feat: a",
    "fix: b",
    "chore: c",
    "docs: d",
    "test: e",
  ]);
  expect(found.map((f) => f.id)).not.toContain(CONTRADICTION);
});

test("a title pattern without its format is refused", () => {
  const found = findings(
    "pull_requests:\n  title_pattern: '{key}: {summary}'\n",
    [],
  );
  expect(found.some((f) => f.message.includes("title_pattern needs"))).toBe(
    true,
  );
});

test("a hash key ending the pattern is left unchecked on GitHub Issues", () => {
  const found = findings(
    "pull_requests:\n  title_format: pattern\n  title_pattern: '{summary} ({key})'\n",
    ["a (#1)", "b (#2)", "c (#3)", "d (#4)", "e (#5)"],
  );
  expect(found.map((f) => f.id)).toContain("unchecked:title-pattern");
  expect(found.map((f) => f.id)).not.toContain(CONTRADICTION);
});

test("a pattern the skills refuse is not judged against the history", () => {
  const found = findings(
    "pull_requests:\n  title_format: pattern\n  title_pattern: '{summary}'\n",
    ["a", "b", "c", "d", "e"],
  );
  expect(found.map((f) => f.id)).not.toContain(CONTRADICTION);
  expect(found.some((f) => f.message.includes("exactly once"))).toBe(true);
});
