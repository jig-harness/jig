/**
 * dispatch: a Claude Code pass names its skill as a slash command (`claude -p
 * "/jig:<skill> ..."`), and Claude Code refuses that prompt for a skill whose
 * frontmatter sets `user-invocable: false`, ending the pass before it reads
 * anything. Every plugin skill a pass starts must leave the setting off.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchRecord } from "../lib/launches.ts";
import { pickupPassArgv, stewardPassArgv } from "../lib/session.ts";

const SKILLS = join(import.meta.dir, "../../skills");

const record = {
  id: "20261110T000000Z-00000000",
  token: "0".repeat(32),
  action: "steward",
  repo: "owner/repo",
  pr: null,
  item: "#1",
  vendor: "claude",
  model: null,
  effort: null,
  sessionId: null,
} as unknown as LaunchRecord;

/** The plugin skill a Claude pass's prompt opens with. */
function skillOf(argv: string[]): string {
  const prompt = argv.at(-1) ?? "";
  const skill = /^\/jig:(\S+)/m.exec(prompt)?.[1];
  if (skill === undefined) throw new Error(`no /jig: skill in ${prompt}`);
  return skill;
}

/** The parsed frontmatter of a plugin skill's SKILL.md; fails when it cannot be read. */
function frontmatter(skill: string): Record<string, unknown> {
  const text = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) throw new Error(`no frontmatter in ${skill}`);
  const parsed: unknown = Bun.YAML.parse(block);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`frontmatter of ${skill} is not a mapping`);
  }
  return parsed as Record<string, unknown>;
}

describe("skills a dispatched Claude pass starts", () => {
  for (const [name, argv] of [
    ["steward", stewardPassArgv(record, [])],
    ["pickup", pickupPassArgv(record, [])],
    [
      "batch pickup",
      pickupPassArgv(
        { ...record, batchItems: [{ key: "#1", person: "someone" }] },
        [],
      ),
    ],
  ] as const) {
    it(`${name}: the skill accepts a slash-command prompt`, () => {
      expect(frontmatter(skillOf(argv))["user-invocable"]).not.toBe(false);
    });
  }
});
