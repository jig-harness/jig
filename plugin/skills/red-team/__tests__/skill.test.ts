/** The skill's own pages agree with its personas and name every fallback. */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPersonas } from "../scripts/lib/personas.ts";

const SKILL_DIR = join(import.meta.dir, "..");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const readme = readFileSync(join(SKILL_DIR, "README.md"), "utf8");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
const description = /^description: "(.*)"$/m.exec(frontmatter)?.[1] ?? "";

describe("SKILL.md", () => {
  test("is named for its folder, and its description leads with the trigger and says what it is not for", () => {
    expect(frontmatter).toMatch(/^name: red-team$/m);
    expect(description).toStartWith(
      "Red-team a requirements or architecture document",
    );
    expect(description).toContain(
      "Not for code, a diff or a plan (use review instead)",
    );
    expect(description.length).toBeLessThanOrEqual(512);
  });

  test("names every reference", () => {
    for (const file of readdirSync(join(SKILL_DIR, "references")))
      expect(skill).toContain(`references/${file}`);
  });

  test("lists every persona, with the kinds it reads", () => {
    for (const persona of loadPersonas()) {
      const row = skill
        .split("\n")
        .find((line) => line.includes(`(\`${persona.id}\`)`));
      expect(row, persona.id).toBeDefined();
      expect(row).toContain(persona.name);
      expect(row).toContain(
        persona.reads.length === 2 ? "both kinds" : "requirements",
      );
      expect(readme).toContain(`| ${persona.name} |`);
    }
  });

  test("names the fallback for each way of getting fresh context", () => {
    expect(skill).toContain("**A subagent per persona**");
    expect(skill).toContain("**No subagent tool:**");
    expect(skill).toContain("--context same-session");
    expect(skill).toContain(
      "marks each such persona as not run in fresh context",
    );
    expect(skill).toContain(
      "With nobody there to\n  answer, stop and state the question",
    );
  });

  test("names each step's command", () => {
    for (const step of ["plan", "collect", "fresh", "report"])
      expect(skill).toContain(`scripts/red-team.ts" ${step} `);
  });
});
