import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExitNot } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { cleanEnv, runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Finding = { id: string; severity: string; message: string };

/** config-fit's findings for a repository holding `repository`, on a machine whose user file holds `user`. */
function findings(repository: string, user?: string): Finding[] {
  const dir = scratchRepo({ ".config/jig.yaml": repository });
  const home = mkdtempSync(join(tmpdir(), "jig-audit-home-"));
  dirs.push(dir, home);
  if (user !== undefined) writeFileSync(join(home, "jig.yaml"), user);
  const run = runScript(
    "config-fit.ts",
    ["--offline", "--json"],
    dir,
    cleanEnv({ JIG_HOME: home }),
  );
  expectSpawnExitNot(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    2,
    "config-fit",
  );
  return (JSON.parse(run.out) as { findings: Finding[] }).findings;
}

const USER_FILE = (words: string) => `drive:\n  pass_args: ${words}\n`;

test.each([
  ["drive.pass_args", "[--permission-mode, bypassPermissions]"],
  ["drive.pass_args", "[]"],
  ["drive.pass_args", "null"],
  ["drive.pass_args", "[--permission-mode]"],
  ["drive.codex_bypass", "true"],
  ["drive.codex_bypass", "false"],
])("a repository's file that sets %s to %s is an error", (field, value) => {
  const key = field.split(".")[1] as string;
  const all = findings(`drive:\n  ${key}: ${value}\n`);
  const refused = all.filter((f) => f.id === `user-only:${field}`);
  expect(refused).toHaveLength(1);
  expect(refused[0]?.severity).toBe("error");
  expect(refused[0]?.message).toContain("user file");
});

test.each([
  ["null", "drive: null\n", "null:drive"],
  ["empty", "drive:\n", "null:drive"],
  ["a list", "drive: []\n", "type:drive"],
])(
  "a repository's drive section that is %s is an error, since it would replace the host's",
  (_, repository, id) => {
    expect(findings(repository).find((f) => f.id === id)?.severity).toBe(
      "error",
    );
  },
);

test("a repository's file that sets clones is an error, not a field the skills ignore", () => {
  const all = findings("clones:\n  example/app: /work/app\n");
  expect(all.find((f) => f.id === "refused:clones")?.severity).toBe("error");
  expect(all.find((f) => f.id === "unknown:clones")).toBeUndefined();
});

test("a user file a drive would stop on is a warning about this machine", () => {
  const ending = findings("", USER_FILE("[--permission-mode]")).find(
    (f) => f.id === "fact:user-layer-invalid",
  );
  expect(ending?.severity).toBe("warning");
  expect(ending?.message).toContain("drive.pass_args");
  expect(ending?.message).toContain("--permission-mode");

  const bypass = findings("", "drive:\n  codex_bypass: yes please\n").find(
    (f) => f.id === "fact:user-layer-invalid",
  );
  expect(bypass?.message).toContain("drive.codex_bypass must be true or false");
});

test("a user file a drive can use draws no finding but the fact that it adds them", () => {
  const all = findings(
    "",
    `${USER_FILE("[--permission-mode, bypassPermissions]")}  codex_bypass: true\n`,
  );
  expect(all.find((f) => f.id === "fact:user-layer-invalid")).toBeUndefined();
  expect(all.find((f) => f.id.startsWith("user-only:"))).toBeUndefined();
  const added = all.find((f) => f.id === "fact:user-layer");
  expect(added?.message).toContain("drive.pass_args");
  expect(added?.message).toContain("drive.codex_bypass");
});
