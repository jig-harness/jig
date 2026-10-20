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
    ['spawnSync ("linear", ["issue", "create"]);'],
    ['spawnSync( /* the client */ "linear", ["issue", "create"]);'],
    [
      'import { execFileSync as run } from "node:child_process"; run("linear", ["issue", "create"]);',
    ],
  ])("a direct call is found: %s", (line) => {
    expect(violations("plugin/x.ts", `ok\n${line}\n`)).toMatchObject([
      { rule: "tracker-boundary", file: "plugin/x.ts", line: 2 },
    ]);
  });
  test.each([
    ['Bun.spawn([\n  "linear",\n  "api",\n  query,\n]);'],
    ['spawnSync(\n  "linear",\n  ["issue", "view"],\n);'],
    ["execFileSync(\n\t`linear`, args);"],
  ])("a direct call split over lines is found where it starts: %s", (code) => {
    expect(violations("plugin/x.ts", `ok\n${code}\n`)).toMatchObject([
      { rule: "tracker-boundary", file: "plugin/x.ts", line: 2 },
    ]);
  });
  test.each([
    ['Bun.spawn([ // invoke the tracker\n  "linear", "issue", "create"]);'],
    ['spawnSync( // invoke the tracker\n  "linear", ["issue", "create"]);'],
    ['execFileSync(/* a */ /* b */ "linear", args);'],
    [
      'const { spawnSync: sp } = require("node:child_process");\nsp("linear", args);',
    ],
    [
      'import * as cp from "node:child_process";\ncp.execFileSync("linear", args);',
    ],
    ["const run = cp.spawnSync;\nconst go = run;\ngo(`linear`, args);"],
    ['wrapper("linear", ["issue", "create"]);'],
    ['const url = "https://example.com/x"; spawnSync("linear", args);'],
    ['const open = /[/*]/; spawnSync("linear", args);'],
    ["const s = 'it\\'s // x'; spawnSync(\"linear\", args);"],
    [
      'function valid(url) { return /^https:\\/\\//.test(url); } spawnSync("linear", args);',
    ],
    ['const v = a / b; const w = c / d; spawnSync("linear", args);'],
    [
      `const value = \`\${Bun.spawn([/* launch */ "linear", "issue", "create"])}\`;`,
    ],
    [`const t = \`\${\`\${spawnSync("linear", args)}\`}\`;`],
    ['/* unclosed \nspawnSync("linear", args);'],
    ['// spawnSync("linear", ["issue", "create"]);'],
    ['/* Bun.spawn(["linear", "api"]) */'],
    [
      'import { execFileSync /* binding */ as run } from "node:child_process";\nrun("linear", args);',
    ],
    [
      'const { spawnSync /* a */ : /* b */ sp } = require("node:child_process");\nsp("linear", args);',
    ],
    ['const run /* binding */ = cp.spawnSync;\nrun("linear", args);'],
    ['const run = cp /* a */ . /* b */ spawnSync;\nrun("linear", args);'],
    ['cp /* launch */ .execFileSync("linear", args);'],
    ['new /* a */ Deno /* b */ . /* c */ Command("linear", { args });'],
    ['require("node:child_process").execFileSync("linear", args);'],
    ['this.cp.spawnSync("linear", args);'],
    ['const run = this.cp.spawnSync;\nrun("linear", args);'],
  ])(
    "a call written around comments or through an alias is found: %s",
    (code) => {
      expect(violations("plugin/x.ts", `ok\n${code}\n`)).toMatchObject([
        { rule: "tracker-boundary", file: "plugin/x.ts" },
      ]);
    },
  );
  test.each([
    ['import subprocess as sp\nsp.run(["linear", "issue", "create"])'],
    ['import subprocess as sp\nsp.check_output("linear", shell=False)'],
    ['subprocess.run(  # the tracker\n  ["linear", "issue"])'],
    ['from subprocess import run\nrun("linear", shell=False)'],
    ['from subprocess import call\ncall("linear", shell=False)'],
    ['from subprocess import PIPE, run\nrun("linear", stdout=PIPE)'],
    [
      'from subprocess import (\n  PIPE,  # pipes\n  call as c,\n)\nc("linear")',
    ],
    ['from subprocess import run as r\nr("linear")'],
    ['from subprocess import PIPE, \\\n    run as r\nr("linear", stdout=PIPE)'],
    ['from subprocess \\\n    import run\nrun("linear")'],
    ['import subprocess \\\n    as sp\nsp.run("linear")'],
    ['import subprocess as sp\nsp \\\n    .run("linear")'],
    [
      'from subprocess import (\n  # select the launcher (portable)\n  run as launch,\n)\nlaunch("linear", shell=False)',
    ],
    ['import os, subprocess as sp\nsp.run("linear")'],
    ['import os as o, subprocess as sp\nsp.run("linear")'],
    ['asyncio.create_subprocess_exec("linear", "issue", "create")'],
    ['os.spawnlp("linear", "linear", "issue")'],
    ['from asyncio import create_subprocess_exec as cse\ncse("linear")'],
    ['import asyncio as aio\naio.create_subprocess_exec("linear")'],
  ])("a Python run is found: %s", (code) => {
    expect(violations("plugin/x.py", code)).toMatchObject([
      { rule: "tracker-boundary", file: "plugin/x.py" },
    ]);
  });
  test.each([
    ['console.log("linear", version);'],
    ['settings.set("linear", false);'],
    ['record("linear", adapter);'],
    ['const note = "// not a comment"; log("linear", note);'],
    ['from subprocess import PIPE\nrun("linear")'],
    ['import subprocess\nimport os, json as run\nlog("linear")'],
  ])("a call that does not launch the client is not: %s", (code) => {
    expect(violations("plugin/x.ts", code)).toEqual([]);
  });
  test("a long run of comment markers is matched in linear time", () => {
    const text = `(/*${"*//*".repeat(50_000)}`;
    const started = performance.now();
    expect(violations("plugin/x.ts", text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
  test.each([
    [`const run = ${" ".repeat(2_000)}value;\n`.repeat(10)],
    [`const run = ${" /* c */".repeat(500)}value;\n`.repeat(10)],
    [`const run = ${"a.".repeat(20_000)}value;`],
    [`from subprocess import (${" x,".repeat(20_000)}`],
  ])(
    "a binding that names no launcher is matched in linear time: %#",
    (text) => {
      const started = performance.now();
      expect(violations("plugin/x.ts", text)).toEqual([]);
      expect(performance.now() - started).toBeLessThan(2_000);
    },
  );
  test("a command line does not run on across a line break", () => {
    expect(
      violations("plugin/x.md", "work in a linear\nissue order\n"),
    ).toEqual([]);
  });
  test.each([
    ['type Linear = ResolutionJson["linear"];'],
    ['export const DEFAULT_ADAPTER = "linear";'],
    ['sides.add("linear");'],
    ['Object.hasOwn(area, "linear");'],
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
