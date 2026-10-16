import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorFor, parseGlossary } from "./glossary.ts";
import { REPO_URL, resolveHref, siteRoute } from "./routes.ts";

const repoRoot = join(import.meta.dir, "../../..");

describe("siteRoute", () => {
  test("places the documents the site has a page for", () => {
    expect(siteRoute("GLOSSARY.md")).toBe("/glossary/");
    expect(siteRoute("FEATURES.md")).toBe("/features/");
    expect(siteRoute("modules/M2-generated-artifact-freshness/")).toBe(
      "/modules/M2/",
    );
    expect(siteRoute("modules/M12-parallel-agent-ergonomics/README.md")).toBe(
      "/modules/M12/",
    );
    expect(siteRoute("modules/M7-pr-lifecycle-review/mappings.md")).toBe(
      "/modules/M7/mappings/",
    );
    expect(siteRoute("principles/04-enforcement-ladder.md")).toBe(
      "/principles/4/",
    );
    expect(siteRoute("plugin/skills/drive-pr/README.md")).toBe(
      "/skills/drive-pr/",
    );
    expect(siteRoute("plugin/skills/decide/SKILL.md")).toBe("/skills/decide/");
    expect(siteRoute("plugin/agents/review-arbiter.md")).toBe(
      "/skills/review-arbiter/",
    );
    expect(siteRoute("adoption/greenfield.md")).toBe("/adopt/greenfield/");
    expect(siteRoute("plugin")).toBe("/plugin/");
    const withReadme = (path: string) =>
      path === "plugin/skills/drive-pr/README.md";
    expect(siteRoute("plugin/skills/drive-pr/SKILL.md", withReadme)).toBe(
      "/skills/drive-pr/skill/",
    );
    expect(siteRoute("plugin/skills/decide/SKILL.md", withReadme)).toBe(
      "/skills/decide/",
    );
  });

  test("leaves everything else to the repository", () => {
    expect(
      siteRoute("modules/M2-generated-artifact-freshness/templates/x.md"),
    ).toBeNull();
    expect(siteRoute("scripts/gates.ts")).toBeNull();
  });
});

describe("resolveHref", () => {
  test("resolves a relative link from the linking document", () => {
    expect(
      resolveHref(
        "../M1-gates-enforcement-ladder/",
        "modules/M2-generated-artifact-freshness/README.md",
      ),
    ).toBe("/modules/M1/");
    expect(
      resolveHref("../../GLOSSARY.md#drift", "modules/M2-x/README.md"),
    ).toBe("/glossary/#drift");
  });

  test("sends a file without a page to GitHub, keeping its anchor", () => {
    expect(
      resolveHref("reference/triad/check.ts", "modules/M2-x/README.md"),
    ).toBe(`${REPO_URL}/blob/main/modules/M2-x/reference/triad/check.ts`);
    expect(resolveHref("templates/", "modules/M6-x/README.md")).toBe(
      `${REPO_URL}/tree/main/modules/M6-x/templates`,
    );
  });

  test("opens a file without an extension as a blob, not a tree", () => {
    const isFile = (p: string) => p === "LICENSE";
    expect(resolveHref("LICENSE", "README.md", { isFile })).toBe(
      `${REPO_URL}/blob/main/LICENSE`,
    );
    expect(resolveHref("templates", "README.md", { isFile })).toBe(
      `${REPO_URL}/tree/main/templates`,
    );
  });

  test("maps the repository's own absolute links back onto the site", () => {
    expect(
      resolveHref(
        `${REPO_URL}/blob/main/GLOSSARY.md`,
        "plugin/skills/drive-pr/README.md",
        { glossaryAnchor: () => "pr" },
      ),
    ).toBe("/glossary/#pr");
  });

  test("leaves external links alone", () => {
    expect(resolveHref("https://bun.sh", "README.md")).toBe("https://bun.sh");
    expect(resolveHref("//cdn.example/file.svg", "README.md")).toBe(
      "//cdn.example/file.svg",
    );
    expect(resolveHref("../../outside.md", "README.md")).toBe(
      "../../outside.md",
    );
  });

  test("points an anchor alone at its document's page", () => {
    expect(resolveHref("#install", "plugin/README.md")).toBe(
      "/plugin/#install",
    );
    expect(
      resolveHref("#gitlab-ci", "modules/M8-learning-loop/mappings.md"),
    ).toBe("/modules/M8/mappings/#gitlab-ci");
    expect(resolveHref("#build-order", "design/website.md")).toBe(
      "#build-order",
    );
  });

  test("translates anchors a designed page renames", () => {
    expect(resolveHref("ROADMAP.md", "README.md")).toBe("/whats-new/#roadmap");
    expect(resolveHref("ROADMAP.md#later", "README.md")).toBe(
      "/whats-new/#rm-later",
    );
    expect(
      resolveHref(
        "../ROADMAP.md#10-values-the-skills-still-assume",
        "plugin/README.md",
      ),
    ).toBe("/whats-new/#rm-item-10");
    expect(resolveHref("#the-learning-loop-wraps-both", "FACTORY.md")).toBe(
      "/factory/learning-loop/#learning",
    );
    expect(resolveHref("#what-stays-with-a-person", "FACTORY.md")).toBe(
      "/factory/#person",
    );
    expect(
      resolveHref("FACTORY.md#execution-the-work-item-line", "README.md"),
    ).toBe("/factory/execution/#execution");
  });
});

describe("glossary", () => {
  const entries = parseGlossary(
    readFileSync(join(repoRoot, "GLOSSARY.md"), "utf8"),
  );

  test("reads every entry with a unique anchor", () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(new Set(entries.map((e) => e.anchor)).size).toBe(entries.length);
    expect(entries.find((e) => e.term.startsWith("SSoT"))?.anchor).toBe("ssot");
  });

  test("finds the entry a link text names", () => {
    expect(anchorFor(entries, "SSoT")).toBe("ssot");
    expect(anchorFor(entries, "single source of truth")).toBe("ssot");
    expect(anchorFor(entries, "invariants")).toBe("invariant");
    expect(anchorFor(entries, "a phrase no entry names")).toBeNull();
  });
});
