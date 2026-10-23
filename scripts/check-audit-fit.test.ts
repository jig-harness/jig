import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../plugin/shared/guarded-git-spawn.ts";
import { checkAuditFit } from "./check-audit-fit.ts";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "jig-audit-fit-"));
  temporary.push(path);
  return path;
}
/** git in a scratch repository, without the caller's git environment. */
function git(dir: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const result = spawnSync("git", ["-C", dir, ...args], { env });
  return { ...result, exitCode: result.status };
}

test("check-audit-fit passes on Jig and fails until a new criterion is scored", async () => {
  expect(await checkAuditFit(root)).toBe(0);
  const dir = temp();
  expectSpawnExit(git(dir, "init", "-q"), 0);
  const commit = ["-c", "user.name=t", "-c", "user.email=t@t", "commit"];
  expectSpawnExit(git(dir, ...commit, "-q", "--allow-empty", "-m", "a"), 0);
  const head = git(dir, "rev-parse", "HEAD").stdout.toString().trim();
  const criteria = join(dir, "criteria");
  mkdirSync(join(dir, ".config"), { recursive: true });
  mkdirSync(criteria);
  writeFileSync(
    join(criteria, "M1-gates.yaml"),
    "module: M1\nname: gates\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: convention, statement: A., observe: [a] }\n",
  );
  const record = (criteria: string, commit = head) =>
    `version: 1\nplugin_version: 0.0.0\ndate: "2026-01-01"\ncommit: ${commit}\nshape: library\ncriteria:\n${criteria}`;
  const a = '  M1/a: { score: convention, evidence: "AGENTS.md" }\n';
  writeFileSync(join(dir, ".config/jig-audit.yaml"), record(a));
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(join(dir, ".config/jig.yaml"), "other_tool:\n  key: 1\n");
  expect(await checkAuditFit(dir, criteria)).toBe(0);
  // A commit the history does not hold, as a squash merge leaves the
  // branch commit a record named, fails.
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    record(a, "0123456789abcdef0123456789abcdef01234567"),
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(join(dir, ".config/jig-audit.yaml"), record(a));

  writeFileSync(
    join(criteria, "M1-gates.yaml"),
    `${readFileSync(join(criteria, "M1-gates.yaml"), "utf8")}  - { id: b, level: lite, requires: convention, statement: B., observe: [b] }\n`,
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    record(`${a}  M1/b: { score: absent, evidence: "none" }\n`),
  );
  expect(await checkAuditFit(dir, criteria)).toBe(0);

  writeFileSync(join(dir, "package.json"), '{"scripts": {"gates": "x"}}');
  writeFileSync(
    join(dir, ".config/jig.yaml"),
    "gates:\n  comand: npm run gates\n",
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(
    join(dir, ".config/jig.yaml"),
    "gates:\n  command: npm run missing\n",
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    `${record(`${a}  M1/b: { score: absent, evidence: "none" }\n`)}declined:\n  - refs: ["config/derivation:gates.command"]\n    reason: Not now.\n    revisit_when: Later.\n`,
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);
  // Declining an unknown field does not get it past the gate.
  writeFileSync(
    join(dir, ".config/jig.yaml"),
    "gates:\n  comand: npm run gates\n",
  );
  writeFileSync(
    join(dir, ".config/jig-audit.yaml"),
    `${record(`${a}  M1/b: { score: absent, evidence: "none" }\n`)}declined:\n  - refs: ["config/unknown:gates.comand"]\n    reason: Not now.\n    revisit_when: Later.\n`,
  );
  expect(await checkAuditFit(dir, criteria)).toBe(1);

  rmSync(join(dir, ".config/jig-audit.yaml"));
  expect(await checkAuditFit(dir, criteria)).toBe(2);
});
