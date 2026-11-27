/**
 * A fixture registry over its limit fails the scratch kind, the only kind that
 * reads it, and nothing else: the scheduled run still collects what the other
 * kinds find eligible, and its receipt and exit name the failed kind.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { dump } from "../../shared/yaml.ts";
import type { Receipt } from "../types.ts";
import { idle, setup } from "./orca-fixture.ts";

const script = resolve(import.meta.dir, "../../jig.ts");

/** The installed job's command line, run on a day the machine file collects (or does not) with a registry of two registrations against a limit of one. */
function scheduledRun(
  f: ReturnType<typeof setup>,
  collects: boolean,
  kinds = ["scratch", "worktrees"],
) {
  const declaration = {
    kinds,
    worktree_roots: [join(f.root, "worktrees")],
    scratch_prefixes: [join(f.root, "scratch-")],
    regenerable_paths: [".fallow"],
  };
  const today = Temporal.Now.zonedDateTimeISO("UTC").dayOfWeek % 7;
  const [entry] = f.machine.repositories;
  const home = f.env.HOME as string;
  writeFileSync(
    join(home, ".jig", "jig.yaml"),
    dump({
      gc: {
        ...f.machine,
        repositories: [{ ...entry, bounds: declaration }],
        collect_day: collects ? today : (today + 1) % 7,
      },
    }),
  );
  writeFileSync(join(f.repo, ".config/jig.yaml"), dump({ gc: declaration }));
  f.command(["git", "add", "."]);
  f.command(["git", "commit", "-m", "declare scratch"]);
  f.command(["git", "push", "origin", "main"]);
  f.command(["git", "fetch", "origin"]);
  const store = join(home, ".local", "state", "jig", "test-fixtures-v1");
  for (const name of ["first", "second"])
    mkdirSync(join(store, name), { recursive: true });
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(script), "gc", "bunfig.toml")}`,
      script,
      "gc",
      "--scheduled",
      "--json",
    ],
    {
      cwd: f.repo,
      env: { ...f.env, JIG_TEST_FIXTURE_REGISTRY_LIMIT: "1", TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
  return result;
}

describe.skipIf(
  skipsOnWindows(
    "git-bash",
    "the fixture remote is served through a shell script as the SSH command, and the remove hook is one",
  ),
)("a fixture registry over its limit", () => {
  test("a scheduled collecting run still collects a worktree; its receipt fails scratch alone", () => {
    const f = setup();
    idle(f);
    const result = scheduledRun(f, true);
    expectSpawnExit(result, 1);
    const receipt = JSON.parse(result.stdout.toString()) as Receipt;
    expect(receipt.collect).toBe(true);
    expect(existsSync(f.tree)).toBe(false);
    expect(receipt.resources).toContainEqual(
      expect.objectContaining({ kind: "worktrees", outcome: "collected" }),
    );
    const status = Object.fromEntries(
      receipt.kinds.map((kind) => [kind.name, kind.status]),
    );
    expect(status.scratch).toBe("failed");
    expect(
      receipt.kinds.filter((kind) => kind.name !== "scratch"),
    ).not.toHaveLength(0);
    for (const kind of receipt.kinds)
      expect(kind.status).toBe(kind.name === "scratch" ? "failed" : "run");
    expect(receipt.failure).toMatchObject({
      code: "fixture-registry-over-limit",
      kind: "scratch",
      reason: expect.stringMatching(/^scratch: /),
    });
    expect(result.stderr.toString()).toContain("scratch: ");
  }, 90_000);

  test("a scheduled collecting run with no scratch plan still collects a worktree and names scratch", () => {
    const f = setup();
    idle(f);
    const result = scheduledRun(f, true, ["worktrees"]);
    expectSpawnExit(result, 1);
    const receipt = JSON.parse(result.stdout.toString()) as Receipt;
    expect(existsSync(f.tree)).toBe(false);
    expect(receipt.kinds.map((kind) => kind.name)).not.toContain("scratch");
    for (const kind of receipt.kinds) expect(kind.status).toBe("run");
    expect(receipt.failure).toMatchObject({
      code: "fixture-registry-over-limit",
      kind: "scratch",
      reason: expect.stringContaining("no scratch collection plan"),
    });
  }, 90_000);

  test("a scheduled report-only run reports every kind and fails scratch alone", () => {
    const f = setup();
    idle(f);
    const result = scheduledRun(f, false);
    expectSpawnExit(result, 1);
    const receipt = JSON.parse(result.stdout.toString()) as Receipt;
    expect(receipt.collect).toBe(false);
    expect(existsSync(f.tree)).toBe(true);
    expect(receipt.resources).toContainEqual(
      expect.objectContaining({ kind: "worktrees", outcome: "would-collect" }),
    );
    for (const kind of receipt.kinds)
      expect(kind.status).toBe(kind.name === "scratch" ? "failed" : "run");
    expect(receipt.failure).toMatchObject({ kind: "scratch" });
  }, 90_000);
});
