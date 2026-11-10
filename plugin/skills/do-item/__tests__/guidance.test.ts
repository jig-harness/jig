/**
 * Implementation guidance (`do_item.guidance` and the areas'
 * `implementation`): which entries match an item, in what order, and what
 * determine_agent.ts prints for it, the skills nothing installed answers
 * included.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { SkillSearch } from "../../../shared/skill-resolve.ts";
import { guidanceFor, parseAgentRouting } from "../scripts/determine_agent.ts";
import { parseGuidance } from "../scripts/lib/guidance.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "determine_agent.ts");

let dir: string;
let search: SkillSearch;

/** A skill installed as a project skill of the test repository. */
function install(name: string): void {
  const skill = join(dir, "repo", ".claude", "skills", name);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "guidance-"));
  mkdirSync(join(dir, "repo"));
  search = {
    root: join(dir, "repo"),
    claudeDir: join(dir, "claude"),
    codexDir: join(dir, "codex"),
    home: join(dir, "home"),
    pluginSkills: join(dir, "plugin-skills"),
  };
  for (const s of ["migration-safety", "api-versioning", "ui-states"])
    install(s);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GUIDANCE = [
  {
    labels: ["kind:db-migration"],
    paths: ["db/migrations/**"],
    skills: ["migration-safety"],
    notes: "Add a rollback script beside every forward migration.",
  },
  {
    labels: ["Kind:API-Change"],
    skills: ["api-versioning", "migration-safety"],
  },
  { paths: ["web/**"], skills: ["ui-states"] },
];

const CATALOG = parseCatalog({
  areas: {
    api: {
      paths: ["api/**"],
      tracker: { labels: ["area:api"] },
      notes: "Contracts are versioned.",
      implementation: { skills: ["api-versioning"], notes: "Keep old fields." },
    },
    migrations: {
      paths: ["db/**"],
      implementation: { skills: ["migration-safety"] },
    },
    docs: { paths: ["docs/**"] },
  },
});

const routing = (guidance: unknown[], codearea: Record<string, string> = {}) =>
  parseAgentRouting({
    do_item: { guidance, agents: { codearea_areas: codearea } },
  });

const guidance = (
  labels: string[],
  paths: string[] | null,
  r = routing(GUIDANCE),
  catalog: typeof CATALOG | null = null,
) => guidanceFor(labels, paths, catalog, r, search);

describe("implementation guidance", () => {
  it("is empty when nothing matches", () => {
    expect(guidance(["bug"], [])).toEqual({
      skills: [],
      notes: [],
      sources: [],
      by_path: [],
      missing_skills: [],
    });
  });

  it("is the union of two matching entries, in entry order", () => {
    const g = guidance(["KIND:API-CHANGE", "kind:db-migration"], null);
    expect(g.skills).toEqual(["migration-safety", "api-versioning"]);
    expect(g.notes).toEqual([
      {
        from: "do_item.guidance[0]",
        text: "Add a rollback script beside every forward migration.",
      },
    ]);
    expect(
      (g.sources as Array<{ from: string; by: string }>).map((s) => [
        s.from,
        s.by,
      ]),
    ).toEqual([
      ["do_item.guidance[0]", "label kind:db-migration"],
      ["do_item.guidance[1]", "label kind:api-change"],
    ]);
  });

  it("matches a planned path like a label", () => {
    const g = guidance([], ["web/app.tsx"]);
    expect(g.skills).toEqual(["ui-states"]);
    expect(g.sources).toEqual([
      {
        from: "do_item.guidance[2]",
        by: "path web/app.tsx",
        skills: ["ui-states"],
        notes: [],
      },
    ]);
  });

  it("lists the path entries apart while the paths are not known", () => {
    const g = guidance([], null);
    expect(g.skills).toEqual([]);
    expect((g.by_path as Array<{ from: string }>).map((b) => b.from)).toEqual([
      "do_item.guidance[0]",
      "do_item.guidance[2]",
    ]);
  });

  it("adds a matched area's implementation and its own notes, after the entries", () => {
    const g = guidance(
      ["area:api", "kind:db-migration"],
      null,
      routing(GUIDANCE),
      CATALOG,
    );
    expect(g.skills).toEqual(["migration-safety", "api-versioning"]);
    expect(g.notes).toEqual([
      {
        from: "do_item.guidance[0]",
        text: "Add a rollback script beside every forward migration.",
      },
      { from: "area api", text: "Keep old fields." },
      { from: "area api", text: "Contracts are versioned." },
    ]);
  });

  it("reaches an area by a mapped label or a planned path, in catalog order", () => {
    const g = guidance(
      ["codearea:database"],
      ["api/x.ts"],
      routing([], { "codearea:database": "migrations" }),
      CATALOG,
    );
    expect(
      (g.sources as Array<{ from: string; by: string }>).map((s) => [
        s.from,
        s.by,
      ]),
    ).toEqual([
      ["area api", "path api/x.ts"],
      ["area migrations", "label codearea:database"],
    ]);
  });

  it("names a skill nothing installed answers", () => {
    const g = guidance(
      ["kind:x"],
      null,
      routing([
        { labels: ["kind:x"], skills: ["no-such-skill", "api-versioning"] },
      ]),
    );
    expect(g.skills).toEqual(["no-such-skill", "api-versioning"]);
    expect(g.missing_skills).toEqual(["no-such-skill"]);
  });
});

describe("parseGuidance", () => {
  it.each([
    [{ guidance: {} }, /must be a list/],
    [{ guidance: [{ skills: ["a"] }] }, /must name labels or paths/],
    [{ guidance: [{ labels: ["x"] }] }, /must give skills or notes/],
    [
      { guidance: [{ labels: ["x"], skill: "a" }] },
      /guidance\[0\]\.skill is not a known field/,
    ],
    [{ guidance: [{ labels: "x", notes: "n" }] }, /labels must be a list/],
    [{ guidance: [{ paths: ["src/{a,b"], notes: "n" }] }, /does not compile/],
    [
      { guidance: [{ labels: ["x"], notes: "" }] },
      /notes must be nonempty text/,
    ],
  ])("refuses %j", (section, message) => {
    expect(() => parseGuidance(section)).toThrow(message);
  });

  it("reads nothing when unset", () => {
    expect(parseGuidance({})).toEqual([]);
  });
});

describe("determine_agent.ts", () => {
  it("prints the guidance and names an unknown skill on stderr", () => {
    const overlay = join(dir, "overlay.yaml");
    writeFileSync(
      overlay,
      "do_item:\n  guidance:\n    - labels: [kind:db-migration]\n      skills: [migration-safety, no-such-skill]\n      notes: Roll back.\n",
    );
    const issue = join(dir, "issue.json");
    writeFileSync(
      issue,
      JSON.stringify({ title: "t", labels: ["kind:db-migration"] }),
    );
    const r = spawnSync(process.execPath, [SCRIPT, issue], {
      cwd: join(dir, "repo"),
      encoding: "utf8",
      env: {
        ...process.env,
        JIG_OVERLAY: overlay,
        JIG_CONSUMER_ROOT: join(dir, "repo"),
        HOME: join(dir, "home"),
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        CODEX_HOME: join(dir, "codex"),
      },
    });
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    const out = JSON.parse(r.stdout);
    expect(out.guidance.skills).toEqual(["migration-safety", "no-such-skill"]);
    expect(out.guidance.missing_skills).toEqual(["no-such-skill"]);
    expect(r.stderr).toContain("Guidance skill not installed: no-such-skill");
  });

  it("refuses a malformed guidance list as a configuration error", () => {
    const overlay = join(dir, "bad.yaml");
    writeFileSync(overlay, "do_item:\n  guidance:\n    - labels: [x]\n");
    const r = spawnSync(process.execPath, [SCRIPT, "-"], {
      input: JSON.stringify({ title: "t", labels: [] }),
      cwd: join(dir, "repo"),
      encoding: "utf8",
      env: {
        ...process.env,
        JIG_OVERLAY: overlay,
        JIG_CONSUMER_ROOT: join(dir, "repo"),
      },
    });
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      1,
    );
    expect(r.stderr).toContain("must give skills or notes");
  });
});
