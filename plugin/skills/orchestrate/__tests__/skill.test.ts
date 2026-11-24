import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { STATE_SECTIONS } from "../scripts/notebook.ts";

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
      Array.from({ length: 15 }, (_, i) => i + 1),
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

  test("suggests a handover at a pause and leaves one session acting", () => {
    const handover = /^### 15\. (.+)$([\s\S]*?)(?=^## |^### |(?![\s\S]))/m.exec(
      skill,
    );
    expect(handover?.[1]).toBe("Hand over before the context fills");
    const step = (handover?.[2] ?? "").replace(/\s+/g, " ");
    expect(step).toContain("natural pause");
    expect(step).toContain("suggest a handover to the person");
    for (const item of [
      "the current state",
      "each decision with its date",
      "what waits on the person",
      "the acts this session still owes",
      "the cautions learned",
      "a first act for the successor",
    ])
      expect(step).toContain(item);
    expect(step).toContain("points at the record");
    expect(step).toContain("give the person the exact command");
    expect(step).toContain(
      "Hand over only with their agreement, never silently",
    );
    expect(step).toContain("no delegated work about to return");
    expect(step).toContain("no question half-asked");
    expect(step).toContain("confirm the successor is alive");
    expect(step).toContain("If it is gone, start it again");
    expect(step).toContain("repeat this confirmation after every replacement");
    expect(step).toContain("keeps ownership but stays quiescent");
    expect(step).toContain("sends no commands, launches nothing");
    expect(step).toContain("Only once a successor is confirmed alive");
    expect(step).toContain("stops acting");
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

  test("names the notebook's place, its parts and when each is written", () => {
    const text = skill.replace(/\s+/g, " ");
    expect(text).toContain("`$JIG_HOME/orchestrate/<topic>/`");
    expect(text).toContain(
      "outside every repository's working tree and never committed",
    );
    expect(text).toContain("belongs to no agent's profile or memory facility");
    expect(text).toContain("rewritten whole at every change of state");
    expect(text).toContain("only ever appended to");
    expect(text).toContain("never in full at start");
    for (const name of STATE_SECTIONS)
      expect(skill).toContain(`\`## ${name}\``);
    for (const moment of [
      "**On start**",
      "**At natural pauses**",
      "**At handover**",
    ])
      expect(text).toContain(moment);
    expect(text).toContain("resume from it alone");
    expect(text).toContain("The topic alone points at the record");
  });

  test("every notebook command printed by the skill runs with its real CLI", () => {
    const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)];
    const lines = (blocks[0]?.[1] ?? "").trim().split("\n");
    expect(lines.map((l) => l.split(" ")[2])).toEqual([
      "open",
      "state",
      "journal",
      "list",
    ]);
    const jigHome = mkdtempSync(join(tmpdir(), "orchestrate-skill-"));
    const state = STATE_SECTIONS.map((name) => `## ${name}\n\nNone.\n`).join(
      "\n",
    );
    for (const line of lines) {
      const match =
        /^bun "\$\{CLAUDE_SKILL_DIR\}([^"]+)" (open|state|journal|list)( "<topic>")?$/.exec(
          line,
        );
      expect(match, line).not.toBeNull();
      const args = match?.[3] === undefined ? [] : ["skill test"];
      const result = Bun.spawnSync(
        [
          process.execPath,
          resolve(directory, `.${match?.[1]}`),
          match?.[2] ?? "",
          ...args,
        ],
        {
          env: { ...process.env, JIG_HOME: jigHome },
          stdin: new TextEncoder().encode(
            match?.[2] === "state" ? state : "An entry.",
          ),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(result, 0);
    }
  });

  test("the configuration command printed by the skill parses with its real CLI", () => {
    const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)];
    expect(blocks).toHaveLength(2);
    for (const [, block] of blocks.slice(1)) {
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
