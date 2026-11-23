// Jig's harness-type counter (ADR-0026) lets the count of Claude Code's and
// Codex's names outside the agent harness's directory only fall: each test
// runs the M1 ratchet with the counter as ratchet.jsonc wires it, in a
// scratch repository whose base already names a harness by value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonc } from "../../modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet-config.ts";
import {
  defaultWiring,
  repo,
} from "../../modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet-test-support.ts";
import type { RatchetConfig } from "../../modules/M1-gates-enforcement-ladder/reference/ratchet/ratchet-types.ts";

const wiring = parseJsonc(
  readFileSync(join(import.meta.dir, "ratchet.jsonc"), "utf8"),
) as RatchetConfig;
const counter = wiring.counters.find((c) => c.name === "harness-type");

const CALLER = "plugin/dispatch/lib/caller.ts";
const base = {
  [CALLER]: 'export const pass = (v: string) => v === "codex";\n',
  "plugin/shared/agent-harness/codex.ts": 'export const name = "codex";\n',
};

function harnessRepo() {
  if (counter === undefined) throw new Error("no harness-type counter");
  return repo(base, { ...defaultWiring, counters: [counter] });
}

describe("the harness-type counter", () => {
  test("is wired as a grep counter over runnable TypeScript", () => {
    expect(counter).toMatchObject({ format: "grep" });
  });

  test("passes a branch that names no harness anew", () => {
    expect(harnessRepo().ratchet()).toMatchObject({ code: 0 });
  });

  test("fails a new harness literal outside the harness directory and names the file", () => {
    const r = harnessRepo();
    r.write(
      "plugin/runtime/new-switch.ts",
      "export const claude = (v: string) => v === 'claude';\n",
    );
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("harness-type harness-literal");
    expect(out).toContain("plugin/runtime/new-switch.ts (0 → 1)");
  });

  test("fails a template literal and a runnable .js file", () => {
    for (const [file, text] of [
      [
        "plugin/runtime/tpl.ts",
        "export const a = (v: string) => v === `claude`;\n",
      ],
      ["plugin/runtime/run.js", "export const a = (v) => v === 'codex';\n"],
    ] as const) {
      const r = harnessRepo();
      r.write(file, text);
      const { code, out } = r.ratchet();
      expect(code).toBe(1);
      expect(out).toContain(`${file} (0 → 1)`);
    }
  });

  test("fails a new use of the two-value type", () => {
    const r = harnessRepo();
    r.write(
      "plugin/skills/drive-pr/scripts/lib/new.ts",
      'import type { AccountVendor } from "./identity.ts";\nexport type V = AccountVendor;\n',
    );
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("harness-type harness-union");
  });

  test("leaves the harness directory, tests and a program's own variables uncounted", () => {
    const r = harnessRepo();
    r.write(
      "plugin/shared/agent-harness/pi.ts",
      'export const names = ["claude", "codex"];\n',
    );
    r.write(
      "plugin/dispatch/__tests__/pass.test.ts",
      'const vendor = "claude";\n',
    );
    r.write("plugin/dispatch/lib/env.ts", 'export const v = "CODEX_HOME";\n');
    expect(r.ratchet()).toMatchObject({ code: 0 });
  });

  test("lets a caller moved behind the interface bring the count down", () => {
    const r = harnessRepo();
    r.write(
      CALLER,
      "export const pass = (v: string) => harnessFor(v).capabilities;\n",
    );
    expect(r.ratchet()).toMatchObject({ code: 0 });
  });
});
