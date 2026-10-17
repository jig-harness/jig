import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_TOOLS } from "../scripts/lib/build-tools.ts";
import { classifyArea } from "../scripts/lib/classify.ts";
import { DEFAULT_AREAS, parseCodeStatsConfig } from "../scripts/lib/config.ts";
import { DATABASE_TOOLS } from "../scripts/lib/database-tools.ts";
import { classified, DEFAULTS, kindOf } from "./helpers.ts";

const CONFIGURED = parseCodeStatsConfig({
  default_area: "repo-config",
  areas: [
    {
      name: "ops",
      paths: [".github/**", "**/Dockerfile", "**/Dockerfile.*", "infra/**"],
    },
    { name: "database", paths: ["tools/db/**"] },
    {
      name: "content",
      description: "Structured content the product loads",
      content: true,
      paths: ["content/**"],
    },
    { name: "tools", paths: ["tools/**", "scripts/**"] },
    { name: "docs", paths: ["docs/**", "*.md", "LICENSE"] },
    { name: "production", paths: ["apps/**", "packages/**", "services/**"] },
  ],
  kinds: {
    test: ["**/smoke-*.sh", "**/*.typetest.ts"],
    fixture: ["**/samples/**"],
    generated: ["docs/catalogue.md"],
  },
});

describe("configured areas: first match wins", () => {
  test.each([
    ["apps/web/src/routes/orders.ts", "production"],
    ["packages/core/src/x.ts", "production"],
    ["tools/db/migrations/0001_init.sql", "database"],
    ["tools/db/seed.ts", "database"],
    [".github/workflows/ci.yml", "ops"],
    ["services/api/Dockerfile", "ops"],
    ["services/api/Dockerfile.release", "ops"],
    ["tools/lint/report.ts", "tools"],
    ["scripts/check.sh", "tools"],
    ["content/catalogue/item.yaml", "content"],
    ["docs/adr/ADR-0001.md", "docs"],
    ["README.md", "docs"],
    ["package.json", "repo-config"],
  ] as const)("%s → %s", (path, area) => {
    expect(classifyArea(path, CONFIGURED).decision.value).toBe(area);
  });

  test("a match names its rule; a fall-through is unmatched", () => {
    expect(classifyArea("infra/main.hcl", CONFIGURED)).toEqual({
      decision: {
        value: "ops",
        rule: 'code_stats.areas[0] "ops" glob "infra/**"',
      },
      matched: true,
    });
    expect(classifyArea("turbo.json", CONFIGURED)).toEqual({
      decision: {
        value: "repo-config",
        rule: "default_area: no area rule matched",
      },
      matched: false,
    });
  });
});

describe("default areas", () => {
  test.each([
    ["scaffolding", ".claude/skills/deploy/SKILL.md"],
    ["scaffolding", "apps/web/AGENTS.md"],
    ["scaffolding", ".github/copilot-instructions.md"],
    ["ci", ".github/workflows/ci.yml"],
    ["ci", ".gitlab-ci.yml"],
    ["build", "Makefile"],
    ["build", "tools/Makefile"],
    ["database", "tools/db/migrations/0001_init.sql"],
    ["database", "apps/api/migrations/0002_orders.sql"],
    ["ops", "infra/main.tf"],
    ["ops", "services/api/Dockerfile"],
    ["ops", "Dockerfile"],
    ["tools", "scripts/release.ts"],
    ["docs", "docs/guide.md"],
    ["docs", "README.md"],
    ["repo-config", "package.json"],
    ["repo-config", ".github/CODEOWNERS"],
    ["repo-config", ".github/dependabot.yml"],
    ["production", "src/index.ts"],
    ["production", "main.go"],
  ] as const)("%s ← %s", (area, path) => {
    expect(classifyArea(path, DEFAULTS).decision.value).toBe(area);
  });

  test("are listed in their documented order, each with a description", () => {
    expect(DEFAULT_AREAS.map((a) => a.name)).toEqual([
      "scaffolding",
      "ci",
      "build",
      "database",
      "ops",
      "tools",
      "docs",
      "repo-config",
    ]);
    for (const area of DEFAULT_AREAS) expect(area.description).toBeTruthy();
  });

  test("a root-level file that is code by its shebang or attribute is not repo-config", () => {
    const script = classified("release", "#!/usr/bin/env bash\necho\n");
    expect(script.kind.value).toBe("code");
    expect(script.area.value).toBe("production");
    const attributed = classified("tool.inc", "", DEFAULTS, new Map(), {
      "linguist-language": "Shell",
    });
    expect([attributed.kind.value, attributed.area.value]).toEqual([
      "code",
      "production",
    ]);
    expect(classified("Brewfile.lock").area.value).toBe("repo-config");
  });

  test("everything else falls to production, unmatched", () => {
    const area = classifyArea("src/app/main.ts", DEFAULTS);
    expect(area.matched).toBe(false);
    expect(area.decision.value).toBe("production");
  });

  test("the database rules take nothing under .github or the scaffolding folders", () => {
    expect(
      classifyArea(".github/migrations/0001.sql", DEFAULTS).decision.value,
    ).toBe("repo-config");
    expect(
      classifyArea(".claude/migrations/notes.md", DEFAULTS).decision.value,
    ).toBe("scaffolding");
  });

  test("a plain .sql file outside a database rule keeps its area", () => {
    expect(classifyArea("apps/api/queries/orders.sql", DEFAULTS).matched).toBe(
      false,
    );
  });
});

describe("the build tool table", () => {
  test.each(BUILD_TOOLS.map((t) => [t.tool, t.example] as const))(
    "%s: %s is build, and the rule names the tool",
    (tool, example) => {
      const { area } = classified(example);
      expect(area.value).toBe("build");
      expect(area.rule).toContain(`build tool: ${tool} (`);
    },
  );

  test("leaves package-manager manifests out", () => {
    for (const path of [
      "package.json",
      "pyproject.toml",
      "go.mod",
      "Gemfile",
      "composer.json",
      "requirements.txt",
    ])
      expect([path, classifyArea(path, DEFAULTS).decision.value]).toEqual([
        path,
        "repo-config",
      ]);
    expect(classifyArea("apps/web/vitest.config.ts", DEFAULTS).matched).toBe(
      false,
    );
  });

  test("a build file is configuration, or code, outside test and fixture folders", () => {
    expect(kindOf("app/build.gradle")).toBe("config");
    expect(kindOf("pom.xml")).toBe("config");
    expect(kindOf("crates/core/build.rs")).toBe("code");
  });

  test("in a test or fixture folder the conventions decide a build file's kind; its area stays build", () => {
    expect(kindOf("tests/fixtures/proj/vite.config.ts")).toBe("fixture");
    expect(kindOf("tests/fixtures/proj/build.rs")).toBe("fixture");
    expect(kindOf("tests/build.rs")).toBe("test");
    expect(kindOf("tests/integration/build.gradle")).toBe("fixture");
    expect(classified("tests/fixtures/proj/vite.config.ts").area.value).toBe(
      "build",
    );
  });
});

describe("the database table", () => {
  test.each(DATABASE_TOOLS.map((t) => [t.tool, t.example] as const))(
    "%s: %s is database, and the rule names it",
    (tool, example) => {
      const { area } = classified(example);
      expect(area.value).toBe("database");
      expect(area.rule).toContain(`database convention: ${tool} (`);
    },
  );

  test("a migration's kind is what the kind rules say", () => {
    expect(kindOf("db/migrate/20260101000000_create_users.rb")).toBe("code");
    expect(kindOf("shop/migrations/0001_initial.py")).toBe("code");
  });
});

describe("kinds", () => {
  test.each([
    ["apps/api/src/services/orders.ts", "code"],
    ["apps/web/src/components/__tests__/a.tsx", "test"],
    ["tools/x/test_parser.py", "test"],
    // Non-code files beside tests are not test LOC.
    ["apps/api/test/payload.json", "fixture"],
    ["apps/api/test/README.md", "docs"],
    ["apps/web/src/__snapshots__/a.test.tsx.snap", "fixture"],
    ["packages/client/src/types.generated.ts", "generated"],
    ["apps/web/src/routeTree.gen.ts", "generated"],
    ["packages/client/src/types.generated.d.ts", "generated"],
    ["packages/client/src/client.gen.d.ts", "generated"],
    ["packages/client/dist/client.generated.js.map", "generated"],
    ["docs/_generated/review-table.md", "generated"],
    ["packages/proto/src/generated/a_pb.ts", "generated"],
    ["pnpm-lock.yaml", "generated"],
    ["Cargo.lock", "generated"],
    ["go.sum", "generated"],
    ["packages/db/drizzle/meta/0001_snapshot.json", "generated"],
    ["docs/adr/ADR-0001.md", "docs"],
    ["biome.json", "config"],
    ["docs/assets/logo.png", "asset"],
    ["apps/web/public/icon.svg", "asset"],
    ["vendor/github.com/x/y/z.go", "vendored"],
    ["third_party/lib/a.c", "vendored"],
    ["data/export.csv", "data"],
    ["notes.unknownext", "other"],
  ] as const)("%s → %s", (path, kind) => {
    expect(kindOf(path)).toBe(kind);
  });

  test("structured files in a content area are data, not configuration", () => {
    expect(kindOf("content/catalogue/item.yaml", "", CONFIGURED)).toBe("data");
    expect(
      classified("content/catalogue/item.yaml", "", CONFIGURED).kind.rule,
    ).toContain('code_stats.areas[2] "content", which has content: true');
    expect(kindOf("tools/x/settings.yaml", "", CONFIGURED)).toBe("config");
  });

  test("code_stats.kinds is checked before built-in detection", () => {
    expect(kindOf("scripts/smoke-login.sh", "", CONFIGURED)).toBe("test");
    expect(kindOf("apps/web/src/a.typetest.ts", "", CONFIGURED)).toBe("test");
    expect(kindOf("docs/catalogue.md", "", CONFIGURED)).toBe("generated");
    expect(classified("tools/x/samples/a.ts", "", CONFIGURED).kind).toEqual({
      value: "fixture",
      rule: 'code_stats.kinds.fixture glob "**/samples/**"',
    });
    expect(kindOf("scripts/smoke-login.sh")).toBe("code");
  });

  test("a package named after testing is not a test folder", () => {
    expect(kindOf("packages/integration/src/adapter.ts")).toBe("code");
    expect(kindOf("packages/attestation/src/a.ts")).toBe("code");
  });

  test("an extensionless script is code in the language its shebang names", () => {
    const c = classified("bin/release", "#!/usr/bin/env bash\necho hi\n");
    expect(c.language).toEqual({
      value: "Shell",
      rule: "shebang (#!/usr/bin/env bash)",
    });
    expect(c.kind.value).toBe("code");
    expect(classified("bin/notes", "plain words\n").kind.value).toBe("other");
  });

  test("an interpreter named like an object property is no language", () => {
    for (const program of ["constructor", "toString", "__proto__"])
      expect(classified("bin/x", `#!/usr/bin/${program}\n`).kind.value).toBe(
        "other",
      );
  });
});

describe("generator banners", () => {
  test("a banner marks a file generated", () => {
    expect(
      kindOf("packages/x/src/schema.ts", "// @generated by a tool\n"),
    ).toBe("generated");
    expect(
      kindOf(
        "tools/db/seeds/05.sql",
        "-- AUTO-GENERATED — do not edit manually.\n",
      ),
    ).toBe("generated");
    expect(
      kindOf(
        "internal/api/types.go",
        "// Code generated by protoc-gen-go. DO NOT EDIT.\n",
      ),
    ).toBe("generated");
  });

  test("prose that merely mentions generation is not a banner", () => {
    expect(
      kindOf(
        "tools/x/diff.ts",
        "/**\n * ids are auto-generated time-ordered keys\n */",
      ),
    ).toBe("code");
    expect(kindOf("apps/x/.gitignore", "# Generated files\ndist/\n")).toBe(
      "config",
    );
  });

  test("a header that discusses the markers is not a banner", () => {
    const own = readFileSync(
      join(import.meta.dir, "..", "scripts", "lib", "banner.ts"),
      "utf8",
    );
    expect(kindOf("plugin/x/banner.ts", own)).toBe("code");
    expect(
      kindOf(
        "src/detect.ts",
        '/**\n * Finds the `@generated` tag and "DO NOT EDIT" notes.\n */\n',
      ),
    ).toBe("code");
    expect(
      kindOf("src/scan.ts", "// Scans headers for @generated markers.\n"),
    ).toBe("code");
  });

  test("banner shapes: a tag, a stated sentence, a quoted generator command", () => {
    for (const head of [
      "/**\n * @generated SignedSource<<abc>>\n */\n",
      "/** @generated */\n",
      "# This file is @generated by uv.\n",
      '// Code generated by "stringer -type=Pill"; DO NOT EDIT.\n',
    ])
      expect([head, kindOf("src/out.ts", head)]).toEqual([head, "generated"]);
  });

  test("the phrase outside the leading comment header is not a banner", () => {
    expect(
      kindOf("apps/x/src/a.ts", "export const warning = 'do not edit';\n"),
    ).toBe("code");
    expect(
      kindOf(
        "apps/x/src/b.ts",
        "import x from 'y';\n// regenerate the schema; do not edit it\n",
      ),
    ).toBe("code");
  });

  test("docs take a banner only from an HTML/MDX comment after frontmatter", () => {
    expect(kindOf("docs/a.md", "Do not edit this table by hand.")).toBe("docs");
    expect(kindOf("docs/b.md", "# Do not edit this\n")).toBe("docs");
    expect(
      kindOf(
        "apps/site/src/content/reference/error-codes.mdx",
        "---\ntitle: Error Codes\n---\n\n{/* AUTO-GENERATED FILE - DO NOT EDIT MANUALLY */}\n",
      ),
    ).toBe("generated");
    expect(kindOf("docs/c.md", "<!-- @generated by x -->\n# T\n")).toBe(
      "generated",
    );
    expect(kindOf("docs/d.md", "---\n---\n<!-- @generated -->\n")).toBe(
      "generated",
    );
  });

  test("a banner inside a leading block comment or HTML comment counts", () => {
    expect(
      kindOf("apps/x/src/c.ts", "/*\n  Generated by X. DO NOT EDIT\n*/\n"),
    ).toBe("generated");
    expect(
      kindOf("apps/x/src/d.ts", "/* header */\nconst a = 1; // do not edit\n"),
    ).toBe("code");
    expect(
      kindOf("apps/x/src/e.vue", "<!-- @generated -->\n<template/>\n"),
    ).toBe("generated");
  });

  test("code after a closing delimiter on the same line ends the header", () => {
    expect(
      kindOf(
        "apps/x/src/f.ts",
        "/* Header\n */ const warning = 'do not edit';\n",
      ),
    ).toBe("code");
    expect(
      kindOf(
        "apps/x/src/g.ts",
        "/* Header */ const warning = 'do not edit';\n",
      ),
    ).toBe("code");
    expect(
      kindOf("apps/x/src/h.ts", "/* Header */ x();\n// @generated\n"),
    ).toBe("code");
    expect(
      kindOf("apps/x/src/i.ts", "/* Header */ /* @generated */\nx();\n"),
    ).toBe("generated");
  });

  test("a markup banner may follow an XML or doctype declaration", () => {
    expect(
      kindOf(
        "apps/x/public/a.html",
        "<!doctype html>\n<!-- @generated; DO NOT EDIT -->\n<html></html>\n",
      ),
    ).toBe("generated");
    expect(
      kindOf(
        "apps/x/config/b.xml",
        '<?xml version="1.0"?>\n<!-- @generated -->\n<root/>\n',
      ),
    ).toBe("generated");
    expect(
      kindOf("apps/x/public/c.html", "<!doctype html>\n<p>do not edit</p>\n"),
    ).not.toBe("generated");
  });
});
