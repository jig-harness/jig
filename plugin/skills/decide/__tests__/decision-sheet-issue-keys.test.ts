/**
 * A decision sheet on a GitHub issue (`#210`): the source is validated
 * without the tracker's configuration, its files are named after the key's
 * file stem, and prose links `#<n>` to the repository of the sheet's URL.
 */
import { describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { renderHtml } from "../scripts/decision-sheet/html.ts";
import { sheetFilename } from "../scripts/decision-sheet/markdown.ts";
import {
  type DecisionSource,
  parseSource,
  SourceError,
} from "../scripts/decision-sheet/source.ts";
import { issueFileStem } from "../scripts/sheet-kit/source.ts";

const FIXTURES = join(import.meta.dir, "fixtures/decision-sheet");
const CLI = join(
  import.meta.dir,
  "../scripts/decision-sheet/decision-sheet.ts",
);
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/** The pilot, moved onto a GitHub issue of `owner/name`. */
function githubPilot(): DecisionSource {
  const text = readFileSync(join(FIXTURES, "pilot.json"), "utf8")
    .replaceAll("ENG-", "#")
    .replace(
      "https://tracker.example.com/acme/issue/#210",
      "https://github.com/owner/name/issues/210",
    );
  return JSON.parse(text) as DecisionSource;
}

const idProblems = (id: string): string[] => {
  try {
    parseSource({ ...githubPilot(), id });
    return [];
  } catch (err) {
    if (err instanceof SourceError) return err.problems;
    throw err;
  }
};

describe("a decision sheet on a GitHub issue", () => {
  it("validates a #<n> id, and no other #-shape", () => {
    expect(idProblems("#210")).toEqual([]);
    for (const id of ["#0", "210", "owner/name#210"])
      expect(idProblems(id).join()).toContain("$.id");
  });

  it("names its files after the key's file stem", () => {
    expect(issueFileStem("#210")).toBe("issue-210");
    expect(issueFileStem("ENG-210")).toBe("ENG-210");
    expect(sheetFilename(parseSource(githubPilot()))).toBe(
      "issue-210-decision-sheet.html",
    );
    const dir = mkdtempSync(join(tmpdir(), "decision-sheet-github-"));
    try {
      const source = join(dir, "source.json");
      writeFileSync(source, JSON.stringify(githubPilot()));
      const out = join(dir, "out");
      expectSpawnExit(
        Bun.spawnSync([process.execPath, CLI, "render", source, "--out", out], {
          cwd: REPO_ROOT,
        }),
        0,
      );
      expect(readdirSync(out).sort()).toEqual([
        "issue-210-comment.md",
        "issue-210-decision-sheet.html",
        "issue-210-elaboration.md",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links #<n> in prose to the repository of the sheet's URL", () => {
    const html = renderHtml(parseSource(githubPilot()), "document");
    expect(html).toContain(
      '<a class="ref-x" href="https://github.com/owner/name/issues/198">#198</a>',
    );
  });
});
