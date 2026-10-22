/**
 * Issue keys in an explainer sheet under each tracker's key shape: a whole
 * citation segment `#123` is an issue only where issues are numbers, and
 * prose links the keys of the tracker the sheet's own issue URL names.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { renderExplainerHtml } from "../scripts/explainer-sheet/html.ts";
import type { ExplainerSource } from "../scripts/explainer-sheet/source.ts";

const SOURCE_TS = join(import.meta.dir, "../scripts/explainer-sheet/source.ts");

const sheet = (
  claim: string,
  source: string,
  url?: string,
): ExplainerSource => ({
  schema: "explainer-sheet/v1",
  id: "minimal",
  title: "A minimal explainer",
  verifiedAt: { date: "2026-10-04", commit: "abcdef1" },
  summary: "One paragraph.",
  scope: { covers: ["One thing"] },
  sections: [
    { id: "only", title: "Only section", claims: [{ text: claim, source }] },
  ],
  ...(url === undefined ? {} : { url }),
});

/** The problems `parseSource` finds in the citation `#123; README.md` under the tracker section `tracker`. */
function citationProblems(tracker: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "explainer-keys-"));
  try {
    const overlay = join(dir, "jig.yaml");
    writeFileSync(overlay, tracker);
    const script = `
      const { parseSource, SourceError } = await import(${JSON.stringify(SOURCE_TS)});
      try { parseSource(${JSON.stringify(sheet("A claim.", "#123; README.md"))}); console.log("[]"); }
      catch (e) { if (!(e instanceof SourceError)) throw e; console.log(JSON.stringify(e.problems)); }`;
    const r = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: dir,
      env: { ...process.env, JIG_OVERLAY: overlay },
    });
    expectSpawnExit(r, 0);
    return JSON.parse(r.stdout.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("citing a GitHub issue as #<n>", () => {
  it("is an issue key under a GitHub tracker", () => {
    expect(citationProblems("issue_tracker:\n  adapter: github\n")).toEqual([]);
  });

  it("names nothing under a team-keyed tracker", () => {
    expect(citationProblems("issue_tracker:\n  team: ENG\n").join()).toContain(
      '"#123" is not a repository path',
    );
  });
});

describe("issue links in prose", () => {
  it("links #<n> to the repository the sheet's GitHub issue is in", () => {
    const html = renderExplainerHtml(
      sheet(
        "See #12, not &#13 or o/r#14.",
        "README.md",
        "https://github.com/owner/name/issues/7",
      ),
    );
    expect(html).toContain(
      '<a class="ref-x" href="https://github.com/owner/name/issues/12">#12</a>',
    );
    expect(html).not.toContain("issues/14");
  });

  it("links a team's keys to the tracker the sheet's issue is in", () => {
    const html = renderExplainerHtml(
      sheet(
        "See ENG-12 and #13.",
        "README.md",
        "https://tracker.example/org/issue/ENG-7/slug",
      ),
    );
    expect(html).toContain(
      '<a class="ref-x" href="https://tracker.example/org/issue/ENG-12">ENG-12</a>',
    );
    expect(html).not.toContain('href="https://tracker.example/org/issue/13"');
  });
});
