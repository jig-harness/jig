import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrownfield, parseGreenfield } from "./adoption.ts";
import { parseLayers, parseTrackerInterface } from "./config.ts";
import { parseCriteria } from "./criteria.ts";
import { parseFlywheel } from "./flywheel.ts";
import {
  DESIGN_NOT_BUILT,
  NOT_BUILT,
  jobsByModule,
  parseFactory,
} from "./factory.ts";
import {
  LEVELS,
  parseMappings,
  parseModule,
  parseModuleIndex,
} from "./modules.ts";
import { parsePrinciple, parsePrincipleIndex } from "./principles.ts";
import { parseProfiles } from "./profiles.ts";
import { parseReadme } from "./readme.ts";
import { parseSkills } from "./skills.ts";
import { parseChangelog, parseRoadmap } from "./whats-new.ts";
import {
  MODULE_IDS,
  parseModule as auditModule,
} from "../../../../plugin/skills/audit/scripts/lib/criteria.ts";
import { parseProfiles as auditProfiles } from "../../../../plugin/skills/audit/scripts/lib/profiles.ts";

const root = join(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("modules", () => {
  const index = parseModuleIndex(read("modules/README.md"));

  test("the index lists every declared module with the skills that run them", () => {
    expect(index.map((m) => m.id)).toEqual([...MODULE_IDS]);
    expect(index.find((m) => m.id === "M7")?.skills).toContain("drive-pr");
    expect(index.find((m) => m.id === "M0")?.skills).toEqual([]);
  });

  test("every module README parses into its parts", () => {
    for (const meta of index) {
      const doc = parseModule(read(`${meta.dir}/README.md`));
      expect(doc.problem.length, meta.id).toBeGreaterThan(80);
      expect(doc.invariant.length, meta.id).toBeGreaterThan(40);
      for (const level of LEVELS)
        expect(doc.levels[level], `${meta.id} ${level}`).not.toBe("");
      expect(doc.steps, meta.id).not.toBe("");
    }
  });

  test("a mappings file splits by section, and CI providers are marked", () => {
    const m = parseMappings(
      read("modules/M2-generated-artifact-freshness/mappings.md"),
    );
    const ci = m.sections
      .flatMap((s) => s.parts.map((p) => p.ci))
      .filter(Boolean);
    expect(ci).toContain("GitHub Actions");
    expect(ci).toContain("GitLab CI");
  });
});

const CRITERIA = "plugin/skills/audit/criteria";
const criteriaFiles = readdirSync(join(root, CRITERIA)).filter((f) =>
  /^M\d+-.*\.yaml$/.test(f),
);

test("every criteria file parses as the audit reads it, and M7 has the most", () => {
  const counts = new Map(
    criteriaFiles.map((f) => {
      const text = read(`${CRITERIA}/${f}`);
      const { module, criteria } = parseCriteria(text);
      const audit = auditModule(text, f);
      expect(module, f).toBe(audit.module);
      expect(criteria, f).toEqual(
        audit.criteria.map(({ id, level, requires, statement, observe }) => ({
          id,
          level,
          requires,
          statement,
          observe,
        })),
      );
      return [module, criteria.length] as const;
    }),
  );
  expect(counts.size).toBe(15);
  expect(Math.max(...counts.values())).toBe(counts.get("M7") ?? -1);
});

// The audit's own loader is the oracle: each malformed case is one it
// rejects, so the site never publishes a criterion the audit would not read.
test("a criterion the audit rejects fails rather than publishing", () => {
  const file = (entry: string, head = "module: M1\nname: X\npurpose: y.\n") =>
    `${head}criteria:\n  - ${entry}`;
  const good =
    "id: one\n    level: lite\n    requires: mechanical\n    statement: x\n    observe: [a]\n";
  expect(parseCriteria(file(good)).criteria[0]?.requires).toBe("mechanical");
  expect(() => auditModule(file(good), "M1.yaml")).not.toThrow();
  for (const text of [
    file(good.replace("mechanical", "mechanicl")),
    file(good.replace("    requires: mechanical\n", "")),
    file(good.replace("lite", "medium")),
    file(good.replace("observe: [a]", "observe: one")),
    file(good.replace("    observe: [a]\n", "")),
    file(good.replace("[a]", "[]")),
    file(good.replace("[a]", "[null, {x: y}]")),
    file(good.replace("id: one", "id: M1-L-1")),
    file(`${good}    extra: 1\n`),
    file(`${good}  - ${good}`),
    file(good, "module: M1\nname: X\n"),
    file(good, "name: X\npurpose: y.\n"),
  ]) {
    expect(() => auditModule(text, "M1.yaml"), text).toThrow();
    expect(() => parseCriteria(text), text).toThrow();
  }
});

test("a profile the audit rejects fails rather than publishing a different plan", () => {
  const readme = read("profiles/README.md");
  const modules = ["M0", "M3"];
  const yaml = (body: string, order = "[M0, M3]") =>
    `version: 1\nprofiles:\n  solo-lite:\n    name: Solo/Lite\n${body}order: ${order}\n`;
  const both = (text: string) => {
    expect(() => auditProfiles(text, "profiles.yaml", modules)).not.toThrow();
    return parseProfiles(text, readme, modules).profiles[0];
  };
  expect(both(yaml("    targets: { M0: lite }\n"))?.targets).toEqual({
    M0: "lite",
  });
  expect(
    both(yaml("    conditional: { M3: { level: lite, when: x } }\n"))?.targets,
  ).toEqual({});
  for (const text of [
    yaml("    targets: { M0: lit }\n"),
    yaml("    targets: M0\n"),
    yaml("    targets: { MO: lite }\n"),
    yaml(
      "    targets: { M0: lite }\n    conditional: { M3: { level: hgh, when: x } }\n",
    ),
    yaml(
      "    targets: { M0: lite }\n    conditional: { M3: { level: lite } }\n",
    ),
    yaml(
      "    targets: { M0: lite }\n    conditional: { M0: { level: strict, when: x } }\n",
    ),
    yaml("    targets: { M0: lite }\n", "[M0]"),
    yaml("    targets: { M0: lite }\n", "[M0, M0]"),
    yaml("    targets: { M0: lite }\n").replace("version: 1\n", ""),
    yaml("    targets: { M0: lite }\n").replace("    name: Solo/Lite\n", ""),
  ]) {
    expect(() => auditProfiles(text, "profiles.yaml", modules), text).toThrow();
    expect(() => parseProfiles(text, readme, modules), text).toThrow();
  }
});

test("profiles carry their targets, order and choosing question", () => {
  const text = read("plugin/skills/audit/profiles.yaml");
  const modules = criteriaFiles.map((f) => f.split("-")[0] ?? f);
  const p = parseProfiles(text, read("profiles/README.md"), modules);
  const audit = auditProfiles(text, "profiles.yaml", modules);
  expect(p.order).toEqual([...audit.order]);
  expect(p.profiles.map((x) => x.name)).toEqual([
    "Solo/Lite",
    "Team/Standard",
    "Regulated/Strict",
  ]);
  for (const x of p.profiles) {
    const a = audit.profiles.get(x.id);
    expect(x.targets, x.id).toEqual(Object.fromEntries(a?.targets ?? []));
    expect(x.conditional, x.id).toEqual(
      Object.fromEntries(a?.conditional ?? []),
    );
    expect(x.question, x.name).toMatch(/\?$/);
    expect(x.rationale, x.name).not.toBe("");
  }
  expect(p.profiles[1]?.conditional.M12?.level).toBe("lite");
});

test("each principle splits into statement, why and consequences", () => {
  const index = parsePrincipleIndex(read("principles/README.md"));
  expect(index.size).toBe(7);
  for (const f of readdirSync(join(root, "principles")).filter((x) =>
    /^\d\d-/.test(x),
  )) {
    const p = parsePrinciple(read(`principles/${f}`));
    expect(p.title, f).not.toBe("");
    expect(p.why, f).not.toBe("");
    expect(p.consequences, f).not.toBe("");
  }
});

test("the plugin's tables give every skill and the agent", () => {
  const skills = parseSkills(read("plugin/README.md"));
  const dirs = readdirSync(join(root, "plugin/skills")).filter((d) =>
    existsSync(join(root, "plugin/skills", d, "SKILL.md")),
  );
  expect(
    skills
      .filter((s) => !s.agent)
      .map((s) => s.name)
      .sort(),
  ).toEqual(dirs.sort());
  expect(skills.find((s) => s.agent)?.command).toBe("jig:review-arbiter");
});

test("the adoption guides parse into steps and phases", () => {
  const b = parseBrownfield(read("adoption/brownfield.md"));
  expect(b.ladder.map((s) => s.lead)).toContain("Audit");
  expect(b.grandfathering).toContain("exception set");
  const g = parseGreenfield(read("adoption/greenfield.md"));
  expect(g.phases).toHaveLength(11);
  expect(g.moves).toHaveLength(3);
});

test("the changelog and roadmap parse into releases and groups", () => {
  const c = parseChangelog(read("CHANGELOG.md"));
  expect(c.releases[0]?.unreleased).toBe(true);
  expect(c.releases.find((r) => !r.unreleased)?.date).toMatch(
    /^\d{4}-\d\d-\d\d$/,
  );
  const r = parseRoadmap(read("ROADMAP.md"));
  expect(r.groups.map((g) => g.name)).toContain("Now");
  expect(r.groups.flatMap((g) => g.items).some((i) => i.n === "9")).toBe(true);
});

test("a changelog subsection with no body keeps its whole title", () => {
  const c = parseChangelog(
    "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added",
  );
  expect(c.releases[0]?.parts).toEqual([{ title: "Added", body: "" }]);
});

test("a `###` inside fenced code is not a subsection", () => {
  const example = "```markdown\n### Example\ntext\n```";
  const c = parseChangelog(
    `# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n${example}`,
  );
  expect(c.releases[0]?.parts).toEqual([{ title: "Added", body: example }]);
  const r = parseRoadmap(`# Roadmap\n\n## Now\n\n### 1. Item\n\n${example}`);
  expect(r.groups[0]?.items).toEqual([
    { n: "1", title: "Item", body: example },
  ]);
  const m = parseMappings(
    `# Mappings\n\n## Tools\n\n### GitHub Actions\n\n${example}`,
  );
  expect(m.sections[0]?.parts).toEqual([
    { title: "GitHub Actions", ci: "GitHub Actions", body: example },
  ]);
});

describe.skipIf(!existsSync(join(root, "FACTORY.md")))("the factory", () => {
  const text = existsSync(join(root, "FACTORY.md")) ? read("FACTORY.md") : "";
  const f = parseFactory(text);

  test("parses the three jobs, both levels and every station", () => {
    expect(f.jobs.map((j) => j.id)).toEqual([
      "context",
      "verification",
      "knowledge",
    ]);
    expect(f.jobs.find((j) => j.id === "verification")?.catches).toContain(
      "M1",
    );
    expect(f.levels).toHaveLength(2);
    expect(f.pipeline).toHaveLength(5);
    expect(f.line.map((s) => s.name)).toEqual([
      "Pick up",
      "Build",
      "Open",
      "Drive",
      "Repair",
      "Merge",
      "Follow up",
    ]);
    expect(f.line.find((s) => s.id === "b6")?.actors[0]).toEqual({
      kind: "person",
    });
    expect(
      f.line.find((s) => s.id === "b4")?.actors.map((a) => a.kind),
    ).toContain("agent");
    expect(jobsByModule(f).get("M5")).toEqual(["guide", "catch", "knowledge"]);
  });

  test("every roadmap item marked not built is one the factory names", () => {
    const items = [
      ...Object.values(NOT_BUILT).flat(),
      ...DESIGN_NOT_BUILT.level,
      ...DESIGN_NOT_BUILT.everyStage,
    ].flatMap((a) => (a.kind === "todo" ? [a.item] : []));
    for (const item of items)
      expect(text, item).toMatch(
        item === "Later" ? /ROADMAP\.md, Later/ : new RegExp(`item ${item}\\b`),
      );
  });
});

test("M8's flywheel has its six steps and two companion cycles", () => {
  const f = parseFlywheel(read("modules/M8-learning-loop/README.md"));
  expect(f.oracle).toMatch(/oracle/i);
  expect(f.steps.map((s) => s.lead)).toEqual([
    "Classify",
    "File with a durable id",
    "Reconstruct as a pre-fix fixture",
    "Answer with an additive lens",
    "Validate, then gate",
    "Measure",
  ]);
  expect(f.cycles).toHaveLength(2);
  expect(f.trigger.title).not.toBe("");
});

test("the configuration layers and the tracker interface's operations", () => {
  const { layers } = parseLayers(read("plugin/CONFIGURATION.md"));
  expect(layers.map((l) => l.name)).toEqual([
    "User",
    "Repository",
    "Environment",
  ]);
  const t = parseTrackerInterface(read("plugin/README.md"));
  expect(t.operations.length).toBeGreaterThanOrEqual(4);
  expect(t.operations[0]).toMatch(/read an issue/);
});

test("the README's factory section and its ways to use Jig", () => {
  const r = parseReadme(read("README.md"));
  expect(r.ways.map((w) => w.lead)).toEqual([
    "Greenfield template",
    "Brownfield upgrade",
    "Reference",
    "Shared tooling",
  ]);
});
