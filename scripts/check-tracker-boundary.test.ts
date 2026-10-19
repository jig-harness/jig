import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reasonedEntries } from "../lib/findings.ts";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import {
  ADAPTERS,
  applyAllowList,
  checkTrackerBoundary,
  inScope,
  violations,
} from "./check-tracker-boundary.ts";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A scratch repository holding `files`, outside any git work tree. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tracker-boundary-"));
  temporary.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const ALLOW = "scripts/tracker-boundary-allow.txt";

describe("scope", () => {
  test("code under plugin/, and every file of the planning skills", () => {
    expect(inScope("plugin/skills/decide/scripts/escalate.ts")).toBe(true);
    expect(inScope("plugin/shared/proc.ts")).toBe(true);
    expect(inScope("plugin/skills/work-batch/SKILL.md")).toBe(true);
    expect(inScope("plugin/skills/file-issue/references/x.md")).toBe(true);
  });
  test.each([
    ["plugin/skills/x/scripts/run.sh"],
    ["plugin/skills/x/scripts/run.bash"],
    ["plugin/skills/x/scripts/run.py"],
    ["plugin/skills/x/scripts/run.js"],
    ["plugin/skills/x/scripts/run.mjs"],
  ])("code in any of the plugin's languages: %s", (path) => {
    expect(inScope(path)).toBe(true);
  });
  test("not the adapters, tests, other skills' documents or other trees", () => {
    expect(inScope(`${ADAPTERS}linear.ts`)).toBe(false);
    expect(inScope("plugin/skills/do-item/__tests__/tracker.test.ts")).toBe(
      false,
    );
    expect(inScope("plugin/skills/work-batch/__tests__/helpers.ts")).toBe(
      false,
    );
    expect(inScope("plugin/skills/do-item/SKILL.md")).toBe(false);
    expect(inScope("tools/launcher/trackers/linear.ts")).toBe(false);
  });
});

describe("tokens", () => {
  test.each([
    ['const API = "https://api.linear.app/graphql";'],
    ['import { LinearClient } from "@linear/sdk";'],
    ["call `mcp__linear__save_issue` with the id"],
    ["call `mcp__claude_ai_Linear__save_issue` with the id"],
    ["call `mcp__plugin_linear_linear__list_issues`"],
    ["call `mcp__linear-server__get_issue`"],
    ['Bun.spawn(["linear", "api", query]);'],
    ['spawnSync("linear", ["issue", "view"]);'],
    ["run `linear issue create --title x`"],
  ])("a direct call is found: %s", (line) => {
    expect(violations("plugin/x.ts", `ok\n${line}\n`)).toMatchObject([
      { rule: "tracker-boundary", file: "plugin/x.ts", line: 2 },
    ]);
  });
  test.each([
    ['type Linear = ResolutionJson["linear"];'],
    ['export const DEFAULT_ADAPTER = "linear";'],
    ["the work runs in a linear order"],
    ["the Linear adapter, through tracker.ts"],
    ["call `mcp__github__create_issue`"],
  ])("a mention that calls nothing is not: %s", (line) => {
    expect(violations("plugin/x.ts", line)).toEqual([]);
  });
});

describe("allow list", () => {
  const found = violations("plugin/a.ts", "mcp__linear__get_issue");
  test("an allowed file's findings are dropped", () => {
    expect(
      applyAllowList(found, reasonedEntries("# reason\nplugin/a.ts\n")),
    ).toEqual([]);
  });
  test("an entry without a reason, repeated, or allowing nothing is a finding", () => {
    const problems = applyAllowList(
      found,
      reasonedEntries("plugin/a.ts\n\n# reason\nplugin/a.ts\nplugin/b.ts\n"),
    ).map((f) => [f.rule, f.line, f.problem]);
    expect(problems).toEqual([
      [
        "tracker-boundary-allowlist",
        1,
        "plugin/a.ts is allowed without a reason",
      ],
      ["tracker-boundary-allowlist", 4, "plugin/a.ts is listed twice"],
      [
        "tracker-boundary-allowlist",
        5,
        "plugin/b.ts no longer reaches Linear directly (or is out of the boundary's scope)",
      ],
    ]);
  });
});

describe("the gate", () => {
  test("passes a plugin whose only direct call is in the adapters or allowed", () => {
    const dir = scratch({
      [`${ADAPTERS}linear.ts`]: 'const API = "https://api.linear.app";',
      "plugin/skills/x/scripts/defer.ts": 'fetch("https://api.linear.app")',
      "plugin/skills/x/scripts/ok.ts": "export {};",
      [ALLOW]: "# moves later\nplugin/skills/x/scripts/defer.ts\n",
    });
    expect(checkTrackerBoundary(dir)).toBe(0);
  });
  test("fails a direct call from a shell or Python script", () => {
    for (const [path, text] of [
      ["plugin/skills/x/scripts/file.sh", "linear issue create --title x\n"],
      [
        "plugin/skills/x/scripts/file.py",
        'requests.post("https://api.linear.app/graphql")\n',
      ],
    ] as const) {
      const dir = scratch({ [path]: text, [ALLOW]: "" });
      expect(checkTrackerBoundary(dir)).toBe(1);
    }
  });
  test("fails a direct call and a stale entry", () => {
    const dir = scratch({
      "plugin/skills/work-batch/SKILL.md": "Use `mcp__linear__save_issue`.",
      "plugin/skills/x/scripts/ok.ts": "export {};",
      [ALLOW]: "# moved already\nplugin/skills/x/scripts/ok.ts\n",
    });
    expect(checkTrackerBoundary(dir)).toBe(1);
  });
  test("cannot check without a plugin directory, an allow list or a file in scope", () => {
    expect(checkTrackerBoundary(scratch({ [ALLOW]: "" }))).toBe(2);
    expect(
      checkTrackerBoundary(scratch({ "plugin/skills/x/a.ts": "export {};" })),
    ).toBe(2);
    expect(
      checkTrackerBoundary(
        scratch({ "plugin/README.md": "# Plugin", [ALLOW]: "" }),
      ),
    ).toBe(2);
  });
  test("passes this repository", () => {
    const r = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "check-tracker-boundary.ts")],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(r, 0);
  });
});
