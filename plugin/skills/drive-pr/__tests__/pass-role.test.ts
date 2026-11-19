/**
 * drive-pr suite: a pass knows it is a pass before it reads anything else.
 * The prompt of each vendor's documented pass command states the pass role
 * after the skill's invocation, so it differs from the words an arm uses,
 * and `SKILL.md` states the role and its obligations before any other
 * section, the arm procedure included.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PASS_VENDORS,
  passCommand,
  passPrompt,
  passRole,
  skillPrompt,
} from "../scripts/lib/pass-command.ts";

const SKILL = readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8");

/** The heading of the section that states the pass role. */
const ROLE_HEADING = "### Read first: a pass of a running drive";

describe("the pass prompt", () => {
  for (const vendor of PASS_VENDORS) {
    it(`${vendor}: states the pass role and differs from the arm's invocation`, () => {
      const arm = skillPrompt(vendor, "/jig:drive-pr --bots-only 7");
      const prompt = passCommand(vendor, 7).at(-1) as string;
      expect(prompt).toBe(passPrompt(vendor, 7));
      expect(prompt).not.toBe(arm);
      expect(prompt.startsWith(`${arm} `)).toBe(true);
      expect(prompt).toContain(passRole(7));
      expect(prompt).toContain("You are a pass");
      expect(prompt).toContain("pull request 7");
      expect(prompt).toContain("not a request to arm");
      expect(prompt).toContain(
        "A drive or lock whose pid is the one DRIVE_PR_SESSION holds is that driver",
      );
      expect(prompt).toContain(
        "any other live drive on this pull request is one",
      );
      expect(prompt).toContain("finish-round.ts");
    });
  }

  it("keeps the role on one line a printed command can quote in any shell", () => {
    expect(passRole(12)).not.toMatch(/["'`$!%\n\r\\]/);
  });

  it("leaves --bots-only out when the drive is not scoped to bots", () => {
    expect(passPrompt("claude", 7, false)).toBe(
      `/jig:drive-pr 7 ${passRole(7)}`,
    );
  });
});

describe("SKILL.md", () => {
  it("states the pass role before every other section, the arm procedure included", () => {
    const role = SKILL.indexOf(`\n${ROLE_HEADING}\n`);
    expect(role).toBeGreaterThan(-1);
    const firstSection = SKILL.search(/\n##+ /);
    expect(firstSection).toBe(role);
    for (const later of [
      "\n## Running it\n",
      "\n## Entry mode: arm the driver, or work one round (decide first)\n",
      "\n### Arm\n",
      "\n### Driver pass: you are headless and one-shot\n",
    ]) {
      const at = SKILL.indexOf(later);
      expect(at).toBeGreaterThan(role);
    }
  });

  it("names the pass's obligations in that section", () => {
    const start = SKILL.indexOf(`\n${ROLE_HEADING}\n`);
    const end = SKILL.indexOf("\n### ", start + 1);
    const section = SKILL.slice(start, end);
    for (const duty of [
      "$DRIVE_PR_TARGET",
      "$DRIVE_PR_SESSION",
      "finish-round.ts",
      "not a competing drive",
      "Any other live drive on this pull",
      "could not do and why",
    ])
      expect(section).toContain(duty);
  });
});
