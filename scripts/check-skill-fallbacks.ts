// Scope: Jig's own skills (.claude/skills), invoked by slash command in Jig's
// instruction files (every AGENTS.md and CLAUDE.md git lists, and
// CONTRIBUTING.md) and in the skills themselves, checked with M0's
// skill-invocation-fallback reference gate: each invocation names its
// fallback within 10 lines. The plugin's skills are left out: they are
// invoked as /jig:<name>, and their fallback, the installed SKILL.md, lies
// outside this repository's scan. Among the instruction files, fixtures,
// templates and the frozen seeds are left out as the Markdown gates leave
// them out; the skills directory is read whole. No .claude/skills
// folder means no skill to check, which passes.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { repoFiles } from "../lib/files.ts";
import { checkSkillInvocationFallback } from "../modules/M0-instruction-architecture/reference/skill-invocation-fallback/check-skill-invocation-fallback.ts";

const SKIPPED = ["fixtures", "templates", "seeds"];
const INSTRUCTIONS = /(^|\/)(AGENTS|CLAUDE)\.md$/;

export function checkSkillFallbacks(root = "."): number {
  const skills = join(root, ".claude/skills");
  if (!lstatSync(skills, { throwIfNoEntry: false })) {
    console.log(
      "Skill invocation fallback: no .claude/skills, nothing to check",
    );
    return 0;
  }
  const instructions = repoFiles(root)
    .filter((name) => INSTRUCTIONS.test(name) || name === "CONTRIBUTING.md")
    .filter((name) => !name.split("/").some((part) => SKIPPED.includes(part)))
    .map((name) => join(root, name));
  return checkSkillInvocationFallback([
    "--skills",
    skills,
    ...instructions,
    skills,
  ]);
}
if (import.meta.main) cli(() => checkSkillFallbacks(process.argv[2]));
