import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const skills = join(import.meta.dir, "..", "..");
const skill = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");

/** The "Which skill" section: the list an agent picks a skill from. */
function whichSkill(): string {
  const m = /\n## Which skill\n([\s\S]*?)\n## /.exec(skill);
  if (!m?.[1]) throw new Error("SKILL.md has no '## Which skill' section");
  return m[1];
}

test("every skill the plugin ships is in the list an agent picks from", () => {
  const named = new Set(
    [...whichSkill().matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]),
  );
  const shipped = readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(shipped.filter((name) => !named.has(name))).toEqual([]);
});

test("the list's groups are the plugin README's, in its order", () => {
  const readme = readFileSync(join(skills, "..", "README.md"), "utf8");
  const groups = (text: string) =>
    [...text.matchAll(/^- ?\*\*([^*]+?):?\*\*/gm)].map((m) =>
      m[1]?.replace(/[.:]$/, ""),
    );
  // A group is a bold lead line followed by a skills table.
  const readmeGroups = [
    ...readme.matchAll(/^\*\*([^*]+?)\.\*\* [^\n]*\n\n\| Skill \|/gm),
  ].map((m) => m[1]);
  expect(groups(whichSkill())).toEqual(readmeGroups);
});
