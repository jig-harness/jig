import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  normalizeSchema,
  reconcileStepMs,
} from "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../lib/guarded-git-spawn.ts";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

// Filter after merging overrides, including Windows' case-insensitive spelling.
function safeSpawn(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(
      ([key]) =>
        !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
    ),
  );
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing subprocess executable");
  const result = spawnSync(executable, args, { ...options, env });
  return { ...result, exitCode: result.status };
}

const root = resolve(import.meta.dir, "..");
const temp = mkdtempSync(join(tmpdir(), "jig-freshness-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function run(
  path: string,
  args: string[],
  cwd = root,
  env: Record<string, string> = {},
) {
  return safeSpawn([process.execPath, join(root, path), ...args], {
    cwd,
    env: { ...process.env, ...env },
  });
}
function compare(
  path: string,
  args: string[],
  status: number,
  cwd = root,
  env: Record<string, string> = {},
) {
  expectSpawnExit(run(path, args, cwd, env), status);
  if (process.env.JIG_BASH_PARITY === "1")
    expectSpawnExit(
      safeSpawn(
        [
          "bash",
          join(root, ".context/bash-baseline", path.replace(/\.ts$/, ".sh")),
          ...args,
        ],
        { cwd, env: { ...process.env, ...env } },
      ),
      status,
    );
}
const m1 = "modules/M1-gates-enforcement-ladder/reference";
const m2 = "modules/M2-generated-artifact-freshness/reference";
for (const [fixture, status] of [
  ["clean", 0],
  ["bad", 1],
  ["exempt", 0],
  ["does-not-exist", 0],
] as const)
  test(`TODO gate: ${fixture}`, () =>
    compare(`${m1}/grep-gate/check-todo-has-issue.ts`, [], status, root, {
      SRC_DIR: join(root, m1, "grep-gate/fixtures", fixture),
    }));
test("TODO gate: empty root", () =>
  compare(`${m1}/grep-gate/check-todo-has-issue.ts`, [], 0, root, {
    SRC_DIR: temp,
  }));
test("review marker passes unrelated paths and requires marker on staged protected paths", () => {
  const dir = join(temp, "marker");
  mkdirSync(dir);
  expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
  const message = join(dir, "message.txt");
  writeFileSync(message, "chore: example\n");
  const gate = `${m1}/commit-msg-marker/check-review-marker.ts`;
  compare(gate, [message], 0, dir);
  mkdirSync(join(dir, "db/migrations"), { recursive: true });
  writeFileSync(join(dir, "db/migrations/001.sql"), "SELECT 1;\n");
  expectSpawnExit(
    safeSpawn(["git", "-C", dir, "add", "db/migrations/001.sql"]),
    0,
  );
  compare(gate, [message], 1, dir);
  writeFileSync(message, "chore: example\n\n[reviewed:db-migration]\n");
  compare(gate, [message], 0, dir);
  compare(gate, [join(dir, "missing")], 2, dir);
});
test("count and referenced-path fixtures, drift and omission", () => {
  const cwd = join(root, m2, "prose-facts");
  compare(
    `${m2}/prose-facts/check-stated-counts.ts`,
    ["fixture/instructions.md", "fixture/guides", "guides"],
    0,
    cwd,
  );
  compare(
    `${m2}/prose-facts/check-referenced-paths.ts`,
    ["fixture/instructions.md"],
    0,
    cwd,
  );
  const prose = join(temp, "counts.md");
  writeFileSync(prose, "7 guides total\n");
  compare(
    `${m2}/prose-facts/check-stated-counts.ts`,
    [prose, join(cwd, "fixture/guides"), "guides"],
    1,
  );
  writeFileSync(prose, "3 guides total; 99 guides available\n");
  compare(
    `${m2}/prose-facts/check-stated-counts.ts`,
    [prose, join(cwd, "fixture/guides"), "guides"],
    1,
  );
  writeFileSync(prose, "3 guides total; 3 guides available\n");
  compare(
    `${m2}/prose-facts/check-stated-counts.ts`,
    [prose, join(cwd, "fixture/guides"), "guides"],
    0,
  );
  writeFileSync(prose, "spawn 7 workers\n");
  compare(
    `${m2}/prose-facts/check-stated-counts.ts`,
    [prose, join(cwd, "fixture/guides"), "guides"],
    0,
  );
  writeFileSync(prose, "[missing](absent/path.md)\n");
  compare(`${m2}/prose-facts/check-referenced-paths.ts`, [prose], 1);
  writeFileSync(
    prose,
    "```sh\n`absent/path.md`\n```\n[URL](https://example.com/path)\n`<name>/missing`\n",
  );
  compare(`${m2}/prose-facts/check-referenced-paths.ts`, [prose], 0);
});
test("root-relative Markdown links resolve against the repository root", () => {
  const repo = join(temp, "links");
  mkdirSync(join(repo, "docs/sub"), { recursive: true });
  expectSpawnExit(safeSpawn(["git", "init", "-q", repo]), 0);
  writeFileSync(join(repo, "docs/example.md"), "# Example\n");
  const page = join(repo, "docs/sub/page.md");
  const gate = `${m2}/prose-facts/check-referenced-paths.ts`;
  writeFileSync(page, "[example](/docs/example.md)\n");
  compare(gate, [page], 0);
  writeFileSync(page, "[example](/example.md)\n");
  compare(gate, [page], 1);
  writeFileSync(page, "[hosts](/etc/hosts)\n");
  compare(gate, [page], 1);
});
test("relative Markdown links resolve from the document's directory only", () => {
  const repo = join(temp, "relative-links");
  mkdirSync(join(repo, "nested"), { recursive: true });
  mkdirSync(join(repo, "tools"), { recursive: true });
  writeFileSync(join(repo, "tools/setup.md"), "# Setup\n");
  const page = join(repo, "nested/doc.md");
  const gate = `${m2}/prose-facts/check-referenced-paths.ts`;
  // The working directory has tools/setup.md; the document's directory does not.
  writeFileSync(page, "[setup](tools/setup.md)\n");
  compare(gate, [page], 1, repo);
  writeFileSync(page, "`tools/setup.md`\n");
  compare(gate, [page], 0, repo);
  mkdirSync(join(repo, "nested/tools"));
  writeFileSync(join(repo, "nested/tools/setup.md"), "# Setup\n");
  writeFileSync(page, "[setup](tools/setup.md)\n");
  compare(gate, [page], 0, repo);
});
test.skipIf(process.platform === "win32")(
  "index entries sort by normalized path, not native path",
  () => {
    const docs = join(temp, "sort-docs");
    mkdirSync(docs);
    // A backslash in a POSIX file name normalizes to "/", so "a\\z.md" must
    // sort before "a0.md" exactly as "a/z.md" does on Windows.
    writeFileSync(join(docs, "a0.md"), "# Zero\n");
    writeFileSync(join(docs, "a\\z.md"), "# Zed\n");
    const out = join(temp, "sort-index.md");
    expectSpawnExit(run(`${m2}/triad/generate-index.ts`, [docs, out]), 0);
    const links = [...readFileSync(out, "utf8").matchAll(/\]\(([^)]+)\)/g)];
    expect(links.map((match) => match[1])).toEqual(["a/z.md", "a0.md"]);
  },
);
test("index generator preserves deterministic body; gate detects stale and missing", () => {
  const docs = join(root, m2, "triad/fixture/docs");
  const fresh = join(temp, "fresh-index.md");
  expectSpawnExit(run(`${m2}/triad/generate-index.ts`, [docs, fresh]), 0);
  const generated = readFileSync(fresh, "utf8");
  if (process.env.JIG_BASH_PARITY === "1") {
    const old = join(temp, "old-index.md");
    expectSpawnExit(
      safeSpawn([
        "bash",
        join(root, ".context/bash-baseline", `${m2}/triad/generate-index.sh`),
        docs,
        old,
      ]),
      0,
    );
    expect(
      generated.replace("bun generate-index.ts", "sh generate-index.sh"),
    ).toBe(readFileSync(old, "utf8"));
    compare(
      `${m2}/triad/check-index-fresh.ts`,
      [docs, join(temp, "missing-index.md")],
      1,
    );
    writeFileSync(old, "stale\n");
    compare(`${m2}/triad/check-index-fresh.ts`, [docs, old], 1);
  }
  expectSpawnExit(run(`${m2}/triad/check-index-fresh.ts`, [docs, fresh]), 0);
  const again = join(temp, "again.md");
  run(`${m2}/triad/generate-index.ts`, [docs, again]);
  expect(readFileSync(again, "utf8")).toBe(generated);
});
// Windows symlink creation requires Developer Mode or elevation.
test.skipIf(process.platform === "win32")(
  "skill mirror sync/check and regular-file refusal",
  () => {
    const dir = join(temp, "mirror");
    mkdirSync(join(dir, ".claude/skills/example"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/example/SKILL.md"), "# Example\n");
    expectSpawnExit(safeSpawn(["git", "init", "-q", dir]), 0);
    const gate =
      "modules/M0-instruction-architecture/reference/sync-skills-mirror.ts";
    compare(gate, ["--check"], 1, dir);
    compare(gate, [], 0, dir);
    compare(gate, ["--check"], 0, dir);
    rmSync(join(dir, ".claude/skills/example"), { recursive: true });
    compare(gate, ["--check"], 1, dir);
    mkdirSync(join(dir, ".claude/skills/second"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/second/SKILL.md"), "# Second\n");
    compare(gate, [], 0, dir);
    expect(existsSync(join(dir, ".agents/skills/example"))).toBe(false);
    rmSync(join(dir, ".agents/skills/second"));
    mkdirSync(join(dir, ".agents/skills/second"));
    compare(gate, [], 1, dir);
  },
);
test("schema normalization strips volatile statements symmetrically", () => {
  expect(
    normalizeSchema(
      "-- version\nSET foo = bar;\nSELECT pg_catalog.set_config('a', 'b', false);\n\nCREATE TABLE example ();  \n\n\n",
    ),
  ).toBe("CREATE TABLE example ();\n\n");
});
test("schema replay reports missing input as setup error", () =>
  compare(
    `${m2}/ephemeral-replay/check-schema-drift.ts`,
    [join(temp, "missing-migrations"), join(temp, "missing.sql")],
    2,
  ));

test("schema replay orders migrations, normalizes both sides and cleans up", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay");
  mkdirSync(dir);
  writeFileSync(join(dir, "002.sql"), "second\n");
  writeFileSync(join(dir, "001.sql"), "first\n");
  const committed = join(temp, "schema.sql");
  writeFileSync(committed, "-- saved header\nCREATE TABLE example ();\n");
  const commands: string[][] = [];
  const applied: string[] = [];
  const runner = async (args: string[], input?: string): Promise<string> => {
    commands.push(args);
    if (args.includes("psql")) applied.push(input ?? "");
    if (args[0] === "logs")
      return "PostgreSQL init process complete; ready for start up.";
    if (args.includes("pg_dump"))
      return "-- fresh header\nSET foo = bar;\nCREATE TABLE example ();  \n";
    return "";
  };
  expect(await checkSchema(dir, committed, runner)).toBe(0);
  expect(applied).toEqual(["first\n", "second\n"]);
  expect(commands.at(-1)?.slice(0, 2)).toEqual(["rm", "-f"]);
  writeFileSync(committed, "CREATE TABLE different ();\n");
  expect(await checkSchema(dir, committed, runner)).toBe(1);
  const fails = async (args: string[], input?: string): Promise<string> => {
    if (args.includes("psql")) throw new Error("migration failed");
    return runner(args, input);
  };
  expect(checkSchema(dir, committed, fails)).rejects.toThrow(
    "migration failed",
  );
  // Wait for the rejection before checking cleanup completion.
  try {
    await checkSchema(dir, committed, fails);
  } catch {
    /* expected */
  }
  expect(commands.at(-1)?.slice(0, 2)).toEqual(["rm", "-f"]);
});

test("each schema replay uses its own container name", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-names");
  mkdirSync(dir);
  const committed = join(temp, "names.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  const names: string[] = [];
  const runner = async (args: string[]): Promise<string> => {
    if (args[0] === "run") names.push(args[args.indexOf("--name") + 1] ?? "");
    if (args[0] === "logs")
      return "PostgreSQL init process complete; ready for start up.";
    if (args.includes("pg_dump")) return "CREATE TABLE example ();\n";
    return "";
  };
  await Promise.all([
    checkSchema(dir, committed, runner),
    checkSchema(dir, committed, runner),
  ]);
  expect(names).toHaveLength(2);
  expect(names[0]).not.toBe(names[1]);
});
test("a hung docker call times out and the container is still removed", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-hang");
  mkdirSync(dir);
  writeFileSync(join(dir, "001.sql"), "first\n");
  const committed = join(temp, "hang.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  const commands: string[][] = [];
  const hang =
    (stage: string) =>
    async (args: string[]): Promise<string> => {
      commands.push(args);
      if (args.includes(stage)) return new Promise<string>(() => {});
      if (args[0] === "logs")
        return "PostgreSQL init process complete; ready for start up.";
      return "";
    };
  process.env.DOCKER_TIMEOUT_MS = "50";
  try {
    await expect(checkSchema(dir, committed, hang("psql"))).rejects.toThrow(
      "timed out",
    );
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["rm", "-f"]);
    commands.length = 0;
    await expect(checkSchema(dir, committed, hang("logs"))).rejects.toThrow(
      "Postgres init did not complete",
    );
    expect(commands.at(-1)?.slice(0, 2)).toEqual(["rm", "-f"]);
  } finally {
    delete process.env.DOCKER_TIMEOUT_MS;
  }
});

test("a docker run that finishes after the deadline still has its container removed", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-late");
  mkdirSync(dir);
  const committed = join(temp, "late.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  const commands: string[][] = [];
  let exists = false;
  const lateCreate = async (args: string[]): Promise<string> => {
    commands.push(args);
    if (args[0] === "run") {
      // The call ignores its deadline and creates the container afterwards.
      await Bun.sleep(150);
      exists = true;
      return "";
    }
    if (args[0] === "rm") exists = false;
    if (args[0] === "ps") return exists ? "abc123\n" : "";
    return "";
  };
  process.env.DOCKER_TIMEOUT_MS = "50";
  process.env.DOCKER_RECONCILE_MS = "40";
  try {
    await expect(checkSchema(dir, committed, lateCreate)).rejects.toThrow(
      "timed out",
    );
    // Give a late creation time to land before judging the final state.
    await Bun.sleep(250);
    expect(exists).toBe(false);
    const created = commands.findIndex((args) => args[0] === "run");
    expect(commands.slice(created).some((args) => args[0] === "rm")).toBe(true);
  } finally {
    delete process.env.DOCKER_TIMEOUT_MS;
    delete process.env.DOCKER_RECONCILE_MS;
  }
});

test("cleanup retries removal while the container is still listed", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-retry");
  mkdirSync(dir);
  const committed = join(temp, "retry.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  let exists = false;
  let removals = 0;
  const racing = async (args: string[]): Promise<string> => {
    if (args[0] === "run") return new Promise<string>(() => {});
    if (args[0] === "rm") {
      removals++;
      // Creation lands just after the first removal request.
      if (removals === 1) {
        setTimeout(() => (exists = true), 5);
        await Bun.sleep(15);
      } else exists = false;
    }
    if (args[0] === "ps") return exists ? "abc123\n" : "";
    return "";
  };
  const warnings: string[] = [];
  const spy = console.error;
  console.error = (message: string) => void warnings.push(String(message));
  process.env.DOCKER_TIMEOUT_MS = "30";
  process.env.DOCKER_RECONCILE_MS = "20";
  try {
    await expect(checkSchema(dir, committed, racing)).rejects.toThrow(
      "timed out",
    );
    expect(removals).toBeGreaterThanOrEqual(2);
    expect(exists).toBe(false);
    // The run call never settled, so the outcome is reported as unconfirmed.
    expect(warnings.some((line) => line.includes("docker rm -f "))).toBe(true);
  } finally {
    console.error = spy;
    delete process.env.DOCKER_TIMEOUT_MS;
    delete process.env.DOCKER_RECONCILE_MS;
  }
});

test("cleanup keeps listing while the run call is unsettled and the container may appear", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-unsettled");
  mkdirSync(dir);
  const committed = join(temp, "unsettled.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  let exists = false;
  let listings = 0;
  let finishRun = () => {};
  const runner = async (args: string[]): Promise<string> => {
    if (args[0] === "run")
      return new Promise<string>((resolve) => {
        finishRun = () => resolve("");
      });
    if (args[0] === "rm") exists = false;
    if (args[0] === "ps") {
      listings++;
      const seen = exists ? "abc123\n" : "";
      // Creation completes right after the first (empty) listing.
      if (listings === 1)
        setTimeout(() => {
          exists = true;
          finishRun();
        }, 5);
      return seen;
    }
    return "";
  };
  process.env.DOCKER_TIMEOUT_MS = "30";
  process.env.DOCKER_RECONCILE_MS = "20";
  try {
    await expect(checkSchema(dir, committed, runner)).rejects.toThrow(
      "timed out",
    );
    expect(listings).toBeGreaterThanOrEqual(2);
    expect(exists).toBe(false);
  } finally {
    delete process.env.DOCKER_TIMEOUT_MS;
    delete process.env.DOCKER_RECONCILE_MS;
  }
});

test("a failing listing is not read as the container being gone", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-listing");
  mkdirSync(dir);
  const committed = join(temp, "listing.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  const warnings: string[] = [];
  const spy = console.error;
  console.error = (message: string) => void warnings.push(String(message));
  let listings = 0;
  const failingListing = async (args: string[]): Promise<string> => {
    if (args[0] === "run") throw new Error("docker run failed");
    if (args[0] === "ps") {
      listings++;
      throw new Error("cannot connect to the docker daemon");
    }
    return "";
  };
  process.env.DOCKER_RECONCILE_MS = "5";
  try {
    await expect(checkSchema(dir, committed, failingListing)).rejects.toThrow(
      "docker run failed",
    );
    expect(listings).toBe(5);
    expect(warnings.some((line) => line.includes("docker rm -f "))).toBe(true);
    // A transient listing failure is retried, but a rejected run is still unconfirmed.
    warnings.length = 0;
    listings = 0;
    const recovers = async (args: string[]): Promise<string> => {
      if (args[0] === "run") throw new Error("docker run failed");
      if (args[0] === "ps" && ++listings === 1)
        throw new Error("transient daemon error");
      return "";
    };
    await expect(checkSchema(dir, committed, recovers)).rejects.toThrow(
      "docker run failed",
    );
    expect(listings).toBe(5);
    // The run call was rejected, so empty listings alone do not confirm removal.
    expect(warnings.some((line) => line.includes("may still exist"))).toBe(
      true,
    );
  } finally {
    console.error = spy;
    delete process.env.DOCKER_RECONCILE_MS;
  }
});

test("a failed removal that leaves the container is reported", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-rm");
  mkdirSync(dir);
  const committed = join(temp, "rm.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  const warnings: string[] = [];
  const spy = console.error;
  console.error = (message: string) => void warnings.push(String(message));
  const stuck = async (args: string[]): Promise<string> => {
    if (args[0] === "rm") throw new Error("removal failed");
    if (args[0] === "logs")
      return "PostgreSQL init process complete; ready for start up.";
    if (args.includes("pg_dump")) return "CREATE TABLE example ();\n";
    return "";
  };
  try {
    expect(await checkSchema(dir, committed, stuck)).toBe(0);
    expect(warnings.some((line) => line.includes("removal failed"))).toBe(true);
  } finally {
    console.error = spy;
  }
});

test("reconcile step is validated and clamped", () => {
  const spy = console.error;
  console.error = () => {};
  try {
    expect(reconcileStepMs(undefined)).toBe(1000);
    expect(reconcileStepMs("250")).toBe(250);
    expect(reconcileStepMs("86400000")).toBe(10000);
    expect(reconcileStepMs("-5")).toBe(1000);
    expect(reconcileStepMs("0")).toBe(1000);
    expect(reconcileStepMs("1.5")).toBe(1000);
    expect(reconcileStepMs("abc")).toBe(1000);
    expect(reconcileStepMs("Infinity")).toBe(1000);
  } finally {
    console.error = spy;
  }
});

test("a rejected run call is never confirmed, and a late creation is reported or removed", async () => {
  const { checkSchema } = await import(
    "../modules/M2-generated-artifact-freshness/reference/ephemeral-replay/check-schema-drift.ts"
  );
  const dir = join(temp, "replay-rejected");
  mkdirSync(dir);
  const committed = join(temp, "rejected.sql");
  writeFileSync(committed, "CREATE TABLE example ();\n");
  const warnings: string[] = [];
  const spy = console.error;
  console.error = (message: string) => void warnings.push(String(message));
  const scenario = async (lateAfterListing: number) => {
    let exists = false;
    let listings = 0;
    const runner = async (args: string[]): Promise<string> => {
      if (args[0] === "run") throw new Error("client connection lost");
      if (args[0] === "rm") exists = false;
      if (args[0] === "ps") {
        listings++;
        const seen = exists ? "abc123\n" : "";
        // The daemon finishes creating the container after the client gave up.
        if (listings === lateAfterListing) setTimeout(() => (exists = true), 5);
        return seen;
      }
      return "";
    };
    warnings.length = 0;
    await expect(checkSchema(dir, committed, runner)).rejects.toThrow(
      "client connection lost",
    );
    // Wait for any scheduled creation before judging the final state.
    await Bun.sleep(30);
    return {
      exists,
      listings,
      warned: warnings.some((line) =>
        line.includes("docker rm -f ephemeral-replay-"),
      ),
    };
  };
  process.env.DOCKER_RECONCILE_MS = "20";
  try {
    // Creation lands inside the window: it is found and removed, yet the
    // rejected call still leaves the outcome unconfirmed, so a warning follows.
    const inside = await scenario(1);
    expect(inside.exists).toBe(false);
    expect(inside.listings).toBe(5);
    expect(inside.warned).toBe(true);
    // Creation lands after the last listing: the container is orphaned, and the
    // warning is what tells the operator to remove it.
    const after = await scenario(5);
    expect(after.listings).toBe(5);
    expect(after.exists).toBe(true);
    expect(after.warned).toBe(true);
  } finally {
    console.error = spy;
    delete process.env.DOCKER_RECONCILE_MS;
  }
});
