/**
 * The skills that take part in the changelog: each asks, through a command
 * that reads the base's configuration, whether the repository turned the
 * skill on before it mentions a note, and the commands it names exist. A
 * repository without `changelog.file` is never asked for a note.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  cleanEnv,
  commit,
  git,
  KEEP_CHANGELOG,
  repository,
  temporary,
} from "./scratch.ts";

const plugin = join(import.meta.dir, "..", "..", "..");
const skills = join(plugin, "skills");

/** The skills that take part, with the file that holds their instructions. */
const PARTICIPANTS: [string, string][] = [
  ["do-item", join(skills, "do-item", "SKILL.md")],
  ["drive-pr", join(skills, "drive-pr", "SKILL.md")],
  [
    "resolve-review-comments",
    join(skills, "resolve-review-comments", "SKILL.md"),
  ],
  ["resolve-conflicts", join(skills, "resolve-conflicts", "SKILL.md")],
  ["followup", join(plugin, "..", ".claude", "skills", "followup", "SKILL.md")],
];

/** The blank-line-separated blocks of a file that name a command of the changelog skill. */
function blocksNaming(text: string): string[] {
  return text.split(/\n[ \t]*\n/).filter((b) => /changelog\/scripts\//.test(b));
}

/** The block that asks `command` and the two after it, which say what to do when the skill is off. */
function guardAround(text: string, command: string): string {
  const all = text.split(/\n[ \t]*\n/);
  const at = all.findIndex(
    (b) => /changelog\/scripts\//.test(b) && b.includes(command),
  );
  return at === -1 ? "" : all.slice(at, at + 3).join("\n\n");
}

/** An instruction to write, add or update a note. */
const NOTE_INSTRUCTION = /\b(?:write|add|update)\b[^.\n]*\bnote\b/i;

/**
 * Whether `text` asks `command` before it first tells the agent to write, add
 * or update a note: no such instruction stands earlier in the file, nor in
 * the probe's own paragraph before the command.
 */
function asksFirst(text: string, command: string): boolean {
  const all = text.split(/\n[ \t]*\n/);
  const at = all.findIndex(
    (b) => /changelog\/scripts\//.test(b) && b.includes(command),
  );
  if (at === -1) return false;
  const before = [...all.slice(0, at), all[at]?.split(command)[0] ?? ""];
  return !before.some((b) => NOTE_INSTRUCTION.test(b));
}

/** The command each skill asks: the base's configuration, never the branch's. */
const probe = (name: string): string =>
  name === "resolve-conflicts"
    ? "convert.ts"
    : name === "followup"
      ? "status.ts"
      : "check.ts";

describe("asksFirst", () => {
  const command = "changelog/scripts/check.ts";
  const guarded = `Intro.\n\nRun \`bun ${command}\`; when it prints \`not configured\`, stop.\n\nOtherwise write the change note.\n`;
  test("accepts a probe that comes before the note", () => {
    expect(asksFirst(guarded, "check.ts")).toBe(true);
  });
  test("rejects a note asked for before the probe", () => {
    expect(asksFirst(`Write the change note.\n\n${guarded}`, "check.ts")).toBe(
      false,
    );
    expect(
      asksFirst(
        `First add the branch's note, then run \`bun ${command}\`.\n`,
        "check.ts",
      ),
    ).toBe(false);
  });
});

describe("the skills that take part in the changelog", () => {
  for (const [name, path] of PARTICIPANTS) {
    const text = readFileSync(path, "utf8");

    test(`${name} names the changelog skill's commands`, () => {
      expect(blocksNaming(text).length).toBeGreaterThan(0);
    });

    // Each asks a command that reads the base's configuration (check.ts, or
    // the conversion itself for resolve-conflicts); /followup reads where
    // releases stand on main, which is the base.
    const asks = probe(name);

    test(`${name} asks ${asks} before any note, and stands down where it is off`, () => {
      const guarded = name === "followup" ? text : guardAround(text, asks);
      expect(guarded).toContain(asks);
      if (name === "followup") return;
      expect(guarded).toContain("not configured");
      expect(asksFirst(text, asks)).toBe(true);
    });

    if (name !== "followup" && name !== "resolve-conflicts")
      test(`${name} never decides adoption from the branch's own status.ts`, () => {
        expect(text).not.toContain("changelog/scripts/status.ts");
      });

    test(`${name} names only commands that exist`, () => {
      const commands = [
        ...text.matchAll(/changelog\/scripts\/([a-z-]+\.ts)/g),
      ].map((m) => m[1] ?? "");
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands)
        expect([
          command,
          existsSync(join(skills, "changelog", "scripts", command)),
        ]).toEqual([command, true]);
    });
  }
});

describe("a repository that did not turn the skill on", () => {
  const scripts = join(skills, "changelog", "scripts");
  const run = (command: string, cwd: string, ...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [join(scripts, command), ...args],
      {
        cwd,
        env: cleanEnv({ JIG_HOME: temporary("jig-home-") }),
      },
    );
    return { code: result.status, out: result.stdout };
  };

  test("every command a participating skill runs passes and says so", () => {
    const root = repository({ "CHANGELOG.md": KEEP_CHANGELOG });
    git(root, "checkout", "-qb", "work");
    commit(root, { "CHANGELOG.md": `${KEEP_CHANGELOG}\nmore\n` }, "edit");
    for (const [command, args] of [
      ["status.ts", []],
      ["check.ts", ["--base", "main"]],
      ["convert.ts", ["--base", "main", "--dry-run"]],
    ] as const) {
      const result = run(command, root, ...args);
      expect([command, result.code]).toEqual([command, 0]);
      expect(result.out).toContain("not configured");
    }
  });
});
