import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrownfield, parseGreenfield } from "./adoption.ts";
import { parseLayers, parseTrackerInterface } from "./config.ts";
import { parseCriteria } from "./criteria.ts";
import { FEATURE_PLATES, parseFeatures } from "./features.ts";
import { parseFlywheel } from "./flywheel.ts";
import {
  DESIGN_NOT_BUILT,
  HANDOFFS,
  NOT_BUILT,
  VERIFY_PHASES,
  VERIFY_WHEN,
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
import { parseChangelog, parseRoadmap, roadmapAnchor } from "./whats-new.ts";
import { PLATES } from "../plates.ts";
import { headingId } from "../view.ts";
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

test("every criteria file parses as the audit reads it", () => {
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
  expect(counts.size).toBe(16);
  for (const [module, n] of counts) expect(n, module).toBeGreaterThan(0);
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

test("the skills are in families, in the order they are used, each saying how it works with the others", () => {
  const skills = parseSkills(read("plugin/README.md")).filter((s) => !s.agent);
  for (const s of skills) {
    expect(s.family?.blurb, s.name).toBeTruthy();
    expect(s.relations, s.name).not.toBe("");
  }
  // Consecutive rows of one family form one group, so a family split in two
  // shows up here as a repeated name.
  const groups: [string | undefined, string[]][] = [];
  for (const s of skills) {
    const last = groups.at(-1);
    if (last && last[0] === s.family?.name) last[1].push(s.name);
    else groups.push([s.family?.name, [s.name]]);
  }
  expect(groups).toEqual([
    [
      "Deliver a change",
      [
        "do-item",
        "drive-pr",
        "resolve-review-comments",
        "resolve-conflicts",
        "fix-ci",
      ],
    ],
    ["Review a change", ["review", "github-actions"]],
    [
      "Understand, decide and record",
      ["explain", "decide", "adr", "design-brief-builder"],
    ],
    [
      "Learn from the work",
      ["reflect", "review-reflections", "promote-memory", "descar"],
    ],
    [
      "Inspect and analyse",
      ["audit", "code-stats", "changelog", "programmatic-execution"],
    ],
  ]);
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

test("a roadmap reference links to its item by number, or to any group by name", () => {
  const { groups } = parseRoadmap(
    "# Roadmap\n\n## Now\n\n### 4. Item\n\n## Next\n\n## Later\n",
  );
  expect(roadmapAnchor(groups, "4")).toBe("rm-item-4");
  expect(roadmapAnchor(groups, "Now")).toBe("rm-now");
  expect(roadmapAnchor(groups, "Next")).toBe("rm-next");
  expect(roadmapAnchor(groups, "Later")).toBe("rm-later");
  expect(roadmapAnchor(groups, "Someday")).toBeUndefined();
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

  test("every station has a handoff, and its own text still says what it stands for", () => {
    const stations = [...f.pipeline, ...f.line];
    expect(Object.keys(HANDOFFS).sort()).toEqual(
      stations.map((s) => s.id).sort(),
    );
    for (const s of stations) {
      const h = HANDOFFS[s.id];
      expect(s.what, `${s.id}: ${h?.label}`).toMatch(h?.says ?? /^$/);
    }
  });

  test("the verification axis places exactly the verification job's modules", () => {
    const job = f.jobs.find((j) => j.id === "verification");
    expect(job).toBeDefined();
    const guides = new Set(job?.modules);
    const catches = new Set(job?.catches);
    expect(Object.keys(VERIFY_WHEN).sort()).toEqual(
      [...new Set([...guides, ...catches])].sort(),
    );
    const placed = Object.entries(VERIFY_WHEN);
    for (const [id, w] of placed)
      for (const at of w.at)
        expect(
          Number.isInteger(at) && at >= 0 && at < VERIFY_PHASES.length,
          `${id} at ${at}`,
        ).toBe(true);
    // The first two phases guide, the last two catch: each set the axis
    // draws is exactly the set the job names.
    const drawn = (catching: boolean) =>
      placed
        .filter(([, w]) => w.at.some((at) => at >= 2 === catching))
        .map(([id]) => id)
        .sort();
    expect(drawn(false)).toEqual([...guides].sort());
    expect(drawn(true)).toEqual([...catches].sort());
  });

  test("every roadmap item marked not built is still open", () => {
    const groups = parseRoadmap(read("ROADMAP.md")).groups;
    const open = new Set([
      ...groups.flatMap((g) => g.items.map((i) => i.n)),
      ...groups.map((g) => g.name),
    ]);
    const items = [
      ...Object.values(NOT_BUILT).flat(),
      ...DESIGN_NOT_BUILT.level,
      ...DESIGN_NOT_BUILT.everyStage,
    ].flatMap((a) => (a.kind === "todo" ? [a.item] : []));
    for (const item of items) expect(open.has(item), item).toBe(true);
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

describe("FEATURES.md", () => {
  const f = parseFeatures(read("FEATURES.md"));
  const skills = new Set(
    parseSkills(read("plugin/README.md")).map((s) => s.name),
  );
  const moduleIds = new Set<string>(MODULE_IDS);
  const roadmap = parseRoadmap(read("ROADMAP.md"));
  const open = new Set(roadmap.groups.flatMap((g) => g.items.map((i) => i.n)));
  const groups = new Set(roadmap.groups.map((g) => g.name));

  test("has an intro and a feature per section, each with prose and a practice", () => {
    expect(f.intro).toMatch(/modules/);
    expect(f.features.length).toBeGreaterThanOrEqual(10);
    for (const x of f.features) {
      expect(x.body.length, x.title).toBeGreaterThan(120);
      expect(x.practice, x.title).not.toBe("");
    }
  });

  test("every skill, module, roadmap item and roadmap group a feature names exists", () => {
    for (const x of f.features) {
      for (const s of x.skills)
        expect(skills.has(s), `${x.title}: ${s}`).toBe(true);
      for (const m of x.modules)
        expect(moduleIds.has(m), `${x.title}: ${m}`).toBe(true);
      for (const n of x.roadmapItems)
        expect(open.has(n), `${x.title}: item ${n}`).toBe(true);
      for (const g of x.roadmapGroups)
        expect(groups.has(g), `${x.title}: ${g}`).toBe(true);
    }
  });

  test("every feature has its own plate, and every plate is drawn", () => {
    const ids = f.features.map((x) => headingId(x.title));
    expect(Object.keys(FEATURE_PLATES).sort()).toEqual([...ids].sort());
    const named = Object.values(FEATURE_PLATES);
    expect(new Set(named).size).toBe(named.length);
    for (const name of Object.keys(PLATES))
      expect(
        existsSync(join(root, `website/public/plates/${name}.webp`)),
        name,
      ).toBe(true);
  });

  test("every skill the plugin ships is named by some feature", () => {
    const named = new Set(f.features.flatMap((x) => x.skills));
    for (const s of skills) expect(named.has(s), s).toBe(true);
  });

  test("reads the fields and refuses an unknown one", () => {
    const one = parseFeatures(`# What you get

Intro.

## A thing

Prose about the thing, long enough to count.

- **Skills:** [\`a\`](plugin/skills/a/SKILL.md), [\`b\`](plugin/agents/b.md)
- **Practice:** [M1](modules/M1-x/), [M12](modules/M12-y/)
- **On the roadmap:** this (item 4); that (items 14 and 15); more (item 9);
  the rest (Later)
`);
    expect(one.intro).toBe("Intro.");
    expect(one.features[0]).toMatchObject({
      title: "A thing",
      body: "Prose about the thing, long enough to count.",
      skills: ["a", "b"],
      modules: ["M1", "M12"],
      roadmapItems: ["4", "14", "15", "9"],
      roadmapGroups: ["Later"],
      notBuiltEntries: [
        { text: "this", items: ["4"], groups: [] },
        { text: "that", items: ["14", "15"], groups: [] },
        { text: "more", items: ["9"], groups: [] },
        { text: "the rest", items: [], groups: ["Later"] },
      ],
    });
    expect(
      parseFeatures(
        "# T\n\n## A\n\nProse.\n\n- **Practice:** M1\n- **On the roadmap:** the `x` skill (item 4), which does y (Later)\n",
      ).features[0]?.notBuiltEntries,
    ).toEqual([
      { text: "the `x` skill, which does y", items: ["4"], groups: ["Later"] },
    ]);
    expect(() =>
      parseFeatures(
        "# T\n\n## A\n\nProse.\n\n- **Runs:** x\n- **Practice:** M1\n",
      ),
    ).toThrow(/field must be one of/);
    expect(() => parseFeatures("# T\n\n## A\n\nProse.\n")).toThrow(
      /no Practice/,
    );
    expect(() =>
      parseFeatures(
        "# T\n\n## A\n\nProse.\n\n- **Practice:** M1\n\nMore.\n\n- **Runs:** x\n",
      ),
    ).toThrow(/text after its field list/);
    expect(() =>
      parseFeatures(
        "# T\n\n## A\n\nProse.\n\n- **Skills:** see plugin/skills/a/SKILL.md\n- **Practice:** M1\n",
      ),
    ).toThrow(/more than links/);
    expect(() =>
      parseFeatures(
        "# T\n\n## A\n\nProse.\n\n- **Skills:** [`b`](plugin/skills/a/SKILL.md)\n- **Practice:** M1\n",
      ),
    ).toThrow(/must link/);
    for (const hidden of [
      "- **Practice:** M1\n - **Runs:** x\n",
      "- **Practice:** M1\n  - **Practice:** M2\n",
      "- **Practice:** M1\n  * **Skills:** x\n",
      "- **Practice:** M1\n  1. **Skills:** x\n",
      "- **Practice:** M1\n  **Runs:** x\n",
      "- **Practice:** M1\n  + **Runs:** x\n",
      "- **Practice:** M1\n  1) **Skills:** x\n",
      "- **Practice:** M1\n  12) **Skills:** x\n",
      "- **Practice:** M1\n  -\n",
    ])
      expect(
        () => parseFeatures(`# T\n\n## A\n\nProse.\n\n${hidden}`),
        hidden,
      ).toThrow(/continues a field/);
    for (const before of [
      "+ **Runs:** x\n",
      "1) **Runs:** x\n",
      " - **Runs:** x\n",
      "  - **Practice:** M2\n",
      "**Skills:** x\n",
      "    indented\n",
    ])
      expect(
        () =>
          parseFeatures(
            `# T\n\n## A\n\nProse.\n\n${before}\n- **Practice:** M1\n`,
          ),
        before,
      ).toThrow(/in its prose/);
    for (const plain of [
      "- **Practice:** M1\n  and +1 more, -5 off, 1)x, 2.5 times\n",
      "- **Practice:** M1\n  covers M2 (see 1) above)\n",
    ])
      expect(
        () => parseFeatures(`# T\n\n## A\n\nProse.\n\n${plain}`),
        plain,
      ).not.toThrow();
  });

  test("refuses an On the roadmap parenthetical that is not a roadmap reference", () => {
    const notBuilt = (text: string) =>
      parseFeatures(
        `# T\n\n## A\n\nProse.\n\n- **Practice:** M1\n- **On the roadmap:** ${text}\n`,
      ).features[0];
    expect(notBuilt("missing work ( item 999 )")?.roadmapItems).toEqual([
      "999",
    ]);
    expect(notBuilt("more ( Later )")?.roadmapGroups).toEqual(["Later"]);
    expect(
      notBuilt("this (roadmap item 9); that (roadmap items 14 and 15)")
        ?.notBuiltEntries,
    ).toEqual([
      { text: "this", items: ["9"], groups: [] },
      { text: "that", items: ["14", "15"], groups: [] },
    ]);
    for (const bad of [
      "missing work (item #999)",
      "missing work (Item 999)",
      "missing work (items 1 & 2)",
      "missing work (item 9; item 10)",
      "missing work (see item 9)",
      "missing work (Roadmap item 9)",
      "missing work (roadmap Later)",
      "missing work (roadmap  item 9)",
      "missing work (later)",
      "missing work (Not Yet)",
      "missing work ()",
      "missing work item 999",
      "missing work (item 999",
      "missing work item 999)",
      "first (item 9); second (item 999",
      "first (item 9); second without a reference",
      "missing work ((item 9))",
    ])
      expect(() => notBuilt(bad), bad).toThrow(/must name roadmap work/);
  });
});
