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
