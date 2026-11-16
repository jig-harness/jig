/**
 * Review gates (`do_item.gates`): which gates an item meets, by a label in
 * any case or a planned path, those only unknown paths could meet, the
 * entries the reader refuses, and what determine_agent.ts prints for them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseGates, resolveGates } from "../scripts/lib/gates.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "determine_agent.ts");

const GATES = [
  {
    labels: ["kind:db-migration"],
    paths: ["db/**"],
    skill: "migration-review",
  },
  { paths: ["api/**"], skill: "api-review" },
  { labels: ["security"], skill: "security-review" },
];

describe("resolveGates", () => {
  const gates = parseGates({ gates: GATES });

  it("applies every gate the item meets, by a label in any case or a path", () => {
    const r = resolveGates(
      gates,
      ["Kind:DB-Migration", "security"],
      ["api/x.ts"],
    );
    expect(r.applied).toEqual([
      {
        from: "do_item.gates[0]",
        skill: "migration-review",
        why: "do_item.gates[0], for the item's label Kind:DB-Migration",
      },
      {
        from: "do_item.gates[1]",
        skill: "api-review",
        why: "do_item.gates[1], for the changed path api/x.ts",
      },
      {
        from: "do_item.gates[2]",
        skill: "security-review",
        why: "do_item.gates[2], for the item's label security",
      },
    ]);
    expect(r.byPath).toEqual([]);
  });

  it("holds apart the gates only unknown paths could meet", () => {
    const r = resolveGates(gates, ["security"], null);
    expect(r.applied.map((g) => g.skill)).toEqual(["security-review"]);
    expect(r.byPath).toEqual([
      { from: "do_item.gates[0]", skill: "migration-review", paths: ["db/**"] },
      { from: "do_item.gates[1]", skill: "api-review", paths: ["api/**"] },
    ]);
  });
});

describe("parseGates", () => {
  it.each([
    [{ gates: {} }, /must be a list/],
    [{ gates: [{ skill: "a" }] }, /must name labels or paths/],
    [{ gates: [{ labels: ["x"] }] }, /skill must name a skill/],
    [
      { gates: [{ labels: ["x"], skill: "a", skills: [] }] },
      /skills is not a known field/,
    ],
    [{ gates: [{ paths: ["a/{b"], skill: "a" }] }, /does not compile/],
  ])("refuses %j", (section, message) => {
    expect(() => parseGates(section)).toThrow(message);
  });
});

describe("determine_agent.ts", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gates-"));
    mkdirSync(join(dir, "repo"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the gates the item meets and those its paths could", () => {
    const overlay = join(dir, "jig.yaml");
    writeFileSync(overlay, JSON.stringify({ do_item: { gates: GATES } }));
    const r = spawnSync(process.execPath, [SCRIPT, "-"], {
      input: JSON.stringify({ title: "t", labels: ["SECURITY"] }),
      cwd: join(dir, "repo"),
      encoding: "utf8",
      env: {
        ...process.env,
        JIG_OVERLAY: overlay,
        JIG_CONSUMER_ROOT: join(dir, "repo"),
      },
    });
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      0,
    );
    const out = JSON.parse(r.stdout) as {
      gates: { applied: { skill: string }[]; by_path: { skill: string }[] };
    };
    expect(out.gates.applied.map((g) => g.skill)).toEqual(["security-review"]);
    expect(out.gates.by_path.map((g) => g.skill)).toEqual([
      "migration-review",
      "api-review",
    ]);
  });
});
