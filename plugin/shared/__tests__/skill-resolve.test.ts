import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  missingSkills,
  parseSkillName,
  resolveSkill,
  type SkillSearch,
  skillSearch,
} from "../skill-resolve.ts";

let dir: string;
let search: SkillSearch;

function skillAt(...parts: string[]): string {
  const d = join(dir, ...parts);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), "---\nname: x\n---\n");
  return join(d, "SKILL.md");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-resolve-"));
  search = {
    root: join(dir, "repo"),
    claudeDir: join(dir, "claude"),
    codexDir: join(dir, "codex"),
    home: join(dir, "home"),
    pluginSkills: join(dir, "plugin", "skills"),
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveSkill", () => {
  it("finds a project skill, with or without a leading slash", () => {
    const file = skillAt("repo", ".claude", "skills", "migration-safety");
    expect(resolveSkill("migration-safety", search)).toBe(file);
    expect(resolveSkill("/migration-safety", search)).toBe(file);
  });

  it("finds the user's skills of either tool", () => {
    expect(resolveSkill("mine", search)).toBeNull();
    const file = skillAt("codex", "skills", "mine");
    expect(resolveSkill("mine", search)).toBe(file);
    const shared = skillAt("home", ".agents", "skills", "shared-one");
    expect(resolveSkill("shared-one", search)).toBe(shared);
  });

  it("finds this plugin's skills bare or by its prefix", () => {
    const file = skillAt("plugin", "skills", "review");
    expect(resolveSkill("jig:review", search)).toBe(file);
    expect(resolveSkill("/jig:review", search)).toBe(file);
    expect(resolveSkill("review", search)).toBe(file);
    expect(resolveSkill("jig:migration-safety", search)).toBeNull();
  });

  it("answers only from an enabled install when Claude Code records installs", () => {
    const base = join(dir, "claude-recorded");
    const rec = { ...search, claudeDir: base };
    const old = join(base, "plugins", "cache", "m", "other", "1.0.0");
    const cur = join(base, "plugins", "cache", "m", "other", "2.0.0");
    for (const [d, s] of [
      [old, "lint"],
      [cur, "fmt"],
    ] as const) {
      mkdirSync(join(d, "skills", s), { recursive: true });
      writeFileSync(join(d, "skills", s, "SKILL.md"), "---\nname: x\n---\n");
    }
    writeFileSync(
      join(base, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "other@m": [{ installPath: cur }] } }),
    );
    expect(resolveSkill("other:lint", rec)).toBeNull();
    expect(resolveSkill("other:fmt", rec)).not.toBeNull();
    writeFileSync(
      join(base, "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@m": false } }),
    );
    expect(resolveSkill("other:fmt", rec)).toBeNull();
  });

  it("finds another plugin's skill in the plugin cache", () => {
    expect(resolveSkill("other:lint", search)).toBeNull();
    const file = skillAt(
      "claude",
      "plugins",
      "cache",
      "market",
      "other",
      "1.0.0",
      "skills",
      "lint",
    );
    expect(resolveSkill("other:lint", search)).toBe(file);
  });

  it("resolves no name that is not a skill name", () => {
    for (const name of ["", "../etc", "a:b:c", "a/b"])
      expect(resolveSkill(name, search)).toBeNull();
    expect(parseSkillName("a/b")).toBeNull();
  });

  it("lists the missing names once each, in order", () => {
    expect(
      missingSkills(["nope", "migration-safety", "nope", "gone"], search),
    ).toEqual(["nope", "gone"]);
  });
});

describe("resolveSkill against the install record", () => {
  let n = 0;
  function recorded(plugins: unknown, raw?: string) {
    const base = join(dir, `recorded-${n++}`);
    const inst = join(base, "plugins", "cache", "m", "other", "1.0.0");
    mkdirSync(join(inst, "skills", "fmt"), { recursive: true });
    writeFileSync(
      join(inst, "skills", "fmt", "SKILL.md"),
      "---\nname: x\n---\n",
    );
    mkdirSync(join(base, "plugins"), { recursive: true });
    writeFileSync(
      join(base, "plugins", "installed_plugins.json"),
      raw ??
        JSON.stringify({
          plugins: plugins instanceof Function ? plugins(inst) : plugins,
        }),
    );
    return { base, inst, rec: { ...search, claudeDir: base } };
  }

  it("ignores an install scoped to another project", () => {
    const { inst, rec } = recorded((p: string) => ({
      "other@m": [
        {
          scope: "project",
          projectPath: join(dir, "elsewhere"),
          installPath: p,
        },
      ],
    }));
    expect(inst).toBeTruthy();
    expect(resolveSkill("other:fmt", rec)).toBeNull();
  });

  it("accepts an install scoped to this project", () => {
    const { rec } = recorded((p: string) => ({
      "other@m": [
        { scope: "project", projectPath: search.root, installPath: p },
      ],
    }));
    expect(resolveSkill("other:fmt", rec)).not.toBeNull();
  });

  it("applies no install whose scope is unrecognized or whose project path is empty", () => {
    for (const extra of [
      { scope: "projec", projectPath: join(dir, "elsewhere") },
      { scope: "project", projectPath: "" },
      { scope: "local" },
    ]) {
      const { rec } = recorded((p: string) => ({
        "other@m": [{ ...extra, installPath: p }],
      }));
      expect(resolveSkill("other:fmt", rec)).toBeNull();
    }
  });

  it("accepts a root whose directory name begins with two dots", () => {
    const parent = join(dir, "dots");
    const root = join(parent, "..worktree");
    mkdirSync(root, { recursive: true });
    const { rec } = recorded((p: string) => ({
      "other@m": [{ scope: "project", projectPath: parent, installPath: p }],
    }));
    expect(resolveSkill("other:fmt", { ...rec, root })).not.toBeNull();
  });

  it("reads settings.local.json from the main checkout of a linked worktree", () => {
    const { rec } = recorded((p: string) => ({
      "other@m": [{ scope: "user", installPath: p }],
    }));
    const main = join(dir, "main-checkout");
    const tree = join(dir, "linked-tree");
    mkdirSync(join(main, ".git", "worktrees", "linked"), { recursive: true });
    mkdirSync(join(main, ".claude"), { recursive: true });
    mkdirSync(tree, { recursive: true });
    writeFileSync(
      join(tree, ".git"),
      `gitdir: ${join(main, ".git", "worktrees", "linked")}\n`,
    );
    writeFileSync(
      join(main, ".claude", "settings.local.json"),
      JSON.stringify({ enabledPlugins: { "other@m": false } }),
    );
    expect(resolveSkill("other:fmt", { ...rec, root: tree })).toBeNull();
  });

  it("applies a managed install, and a project install to a sibling worktree", () => {
    const main = join(dir, "sib-main");
    const tree = join(dir, "sib-tree");
    mkdirSync(join(main, ".git", "worktrees", "worktrees"), {
      recursive: true,
    });
    mkdirSync(tree, { recursive: true });
    writeFileSync(
      join(tree, ".git"),
      `gitdir: ${join(main, ".git", "worktrees", "worktrees")}\n`,
    );
    const { rec } = recorded((p: string) => ({
      "other@m": [{ scope: "project", projectPath: main, installPath: p }],
    }));
    expect(resolveSkill("other:fmt", { ...rec, root: tree })).not.toBeNull();
    const managed = recorded((p: string) => ({
      "other@m": [{ scope: "managed", installPath: p }],
    }));
    expect(resolveSkill("other:fmt", managed.rec)).not.toBeNull();
  });

  it("reads managed settings drop-ins after managed-settings.json", () => {
    const { rec } = recorded((p: string) => ({
      "other@m": [{ scope: "user", installPath: p }],
    }));
    const managedDir = join(dir, "managed");
    mkdirSync(join(managedDir, "managed-settings.d"), { recursive: true });
    writeFileSync(
      join(managedDir, "managed-settings.json"),
      JSON.stringify({ enabledPlugins: { "other@m": true } }),
    );
    expect(resolveSkill("other:fmt", { ...rec, managedDir })).not.toBeNull();
    writeFileSync(
      join(managedDir, "managed-settings.d", "20-plugins.json"),
      JSON.stringify({ enabledPlugins: { "other@m": false } }),
    );
    expect(resolveSkill("other:fmt", { ...rec, managedDir })).toBeNull();
  });

  it("reads enablement from the repository's settings over the user's", () => {
    const { base, rec } = recorded((p: string) => ({
      "other@m": [{ scope: "user", installPath: p }],
    }));
    mkdirSync(join(search.root, ".claude"), { recursive: true });
    writeFileSync(
      join(search.root, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@m": false } }),
    );
    expect(resolveSkill("other:fmt", rec)).toBeNull();
    writeFileSync(
      join(base, "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@m": false } }),
    );
    writeFileSync(
      join(search.root, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@m": true } }),
    );
    expect(resolveSkill("other:fmt", rec)).not.toBeNull();
    rmSync(join(search.root, ".claude", "settings.json"));
  });

  it("fails closed on a record that is not JSON, and scans only when it is absent", () => {
    const { rec } = recorded(null, "{ truncated");
    expect(resolveSkill("other:fmt", rec)).toBeNull();
    const none = { ...search, claudeDir: join(dir, "no-record") };
    const file = join(
      none.claudeDir,
      "plugins",
      "cache",
      "m",
      "other",
      "1.0.0",
      "skills",
      "fmt",
    );
    mkdirSync(file, { recursive: true });
    writeFileSync(join(file, "SKILL.md"), "---\nname: x\n---\n");
    expect(resolveSkill("other:fmt", none)).not.toBeNull();
  });
});

describe("skillSearch", () => {
  it("reads the tools' homes from the environment", () => {
    const s = skillSearch("/r", { HOME: "/h", CLAUDE_CONFIG_DIR: "/c" });
    expect(s).toMatchObject({
      root: "/r",
      home: "/h",
      claudeDir: "/c",
      codexDir: "/h/.codex",
    });
  });
});
