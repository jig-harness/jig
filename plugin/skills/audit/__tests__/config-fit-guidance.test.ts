/**
 * The audit refuses implementation guidance that names a skill nothing
 * installed answers, from `do_item.guidance` and from the change-area
 * catalog's `implementation` blocks alike.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guidanceFindings } from "../scripts/lib/guidance-fit.ts";

let dir: string;
let root: string;
let env: Record<string, string>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "guidance-fit-"));
  root = join(dir, "repo");
  const skill = join(root, ".claude", "skills", "migration-safety");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: migration-safety\n---\n");
  writeFileSync(
    join(root, "areas.yaml"),
    `areas:
  api:
    paths: ['api/**']
    implementation: { skills: [api-versioning, jig:review] }
`,
  );
  env = {
    HOME: join(dir, "home"),
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    CODEX_HOME: join(dir, "codex"),
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("guidanceFindings", () => {
  test("nothing to report without guidance", () => {
    expect(guidanceFindings({}, root, env)).toEqual([]);
  });

  test("refuses each skill that resolves to nothing, naming its field", () => {
    const findings = guidanceFindings(
      {
        do_item: {
          guidance: [
            { labels: ["kind:db-migration"], skills: ["migration-safety"] },
            { labels: ["kind:ui"], skills: ["ui-states"] },
          ],
        },
        drive: { change_areas_catalog: "areas.yaml" },
      },
      root,
      env,
    );
    expect(findings).toEqual([
      {
        id: "derivation:do_item.guidance.skills:ui-states",
        severity: "error",
        message:
          "do_item.guidance[1].skills names ui-states, which resolves to no skill installed for this repository or on this machine: install it, or name a skill that exists",
      },
      {
        id: "derivation:do_item.guidance.skills:api-versioning",
        severity: "error",
        message:
          "area api implementation.skills names api-versioning, which resolves to no skill installed for this repository or on this machine: install it, or name a skill that exists",
      },
    ]);
  });

  test("reports a malformed list, and checks every area after a malformed one", () => {
    writeFileSync(
      join(root, "bad-areas.yaml"),
      `areas:
  first:
    paths: ['a/**']
    implementation: { skills: [] }
  second:
    paths: ['b/**']
    implementation: { skills: [nowhere-skill] }
`,
    );
    const ids = guidanceFindings(
      {
        do_item: { guidance: [{ labels: ["x"] }] },
        drive: { change_areas_catalog: "bad-areas.yaml" },
      },
      root,
      env,
    ).map((f) => f.id);
    expect(ids).toEqual([
      "derivation:do_item.guidance:invalid",
      "derivation:area.first.implementation:invalid",
      "derivation:do_item.guidance.skills:nowhere-skill",
    ]);
  });
});
