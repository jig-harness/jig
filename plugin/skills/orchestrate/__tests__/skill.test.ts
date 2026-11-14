import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const directory = resolve(import.meta.dir, "..");
const skill = readFileSync(join(directory, "SKILL.md"), "utf8");

describe("orchestrate's contract", () => {
  test("routes broad topics separately from the neighbouring skills", () => {
    const description = /^description: "(.*)"$/m.exec(skill)?.[1] ?? "";
    expect(description).toStartWith("A large, loosely bounded topic");
    expect(description.length).toBeLessThanOrEqual(512);
    for (const name of ["do-item", "decide", "explain", "operator"])
      expect(description).toContain(name);
  });

  test("keeps the validated procedure bounded, with a person owning decisions", () => {
    const steps = [...skill.matchAll(/^### (\d+)\. (.+)$/gm)];
    expect(steps.map((s) => Number(s[1]))).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    expect(skill).toContain(
      "never implements, edits repository files, commits, pushes or merges",
    );
    expect(skill).toContain("Hold decisions until every survey has returned");
    expect(skill).toContain("end the turn");
    expect(skill).toContain("never poll for review");
    expect(skill).toContain("stop and state the question");
    expect(skill).toContain("plain file outside the repository");
    expect(skill).toContain("re-measures");
  });

  test("every sibling invocation resolves to an installed skill", () => {
    const commands = [...skill.matchAll(/`\/jig:([a-z-]+)`/g)];
    expect(commands.length).toBeGreaterThan(0);
    for (const [, name] of commands) {
      const target = readFileSync(
        resolve(directory, "..", name ?? "", "SKILL.md"),
        "utf8",
      );
      expect(target).toMatch(new RegExp(`^name: ${name}$`, "m"));
    }
  });

  test("every shell command printed by the skill parses with its real CLI", () => {
    const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)];
    expect(blocks).toHaveLength(1);
    for (const [, block] of blocks) {
      const line = (block ?? "").trim();
      const match =
        /^bun "\$\{CLAUDE_SKILL_DIR\}([^"]+)" dispatch\.identity --json$/.exec(
          line,
        );
      expect(match, line).not.toBeNull();
      const result = Bun.spawnSync(
        [
          process.execPath,
          resolve(directory, `.${match?.[1]}`),
          "dispatch.identity",
          "--json",
        ],
        { cwd: resolve(directory, "../../.."), env: process.env },
      );
      // An unset identity is a valid config read (exit 2), not a parse failure.
      expect([0, 2]).toContain(result.exitCode);
      expect(new TextDecoder().decode(result.stderr)).not.toContain("usage:");
      if (result.exitCode === 0) expectSpawnExit(result, 0);
      else expectSpawnExit(result, 2);
    }
  });
});
