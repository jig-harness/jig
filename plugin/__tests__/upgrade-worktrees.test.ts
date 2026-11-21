/**
 * `jig upgrade` with Claude Code project-scope installs in several worktrees
 * of one repository, run as the installed plugin copy runs
 * (`lifecycle-fixtures.ts`): Claude Code's scoped update refreshes the first
 * record of the repository wherever it runs (`agent-fakes.ts`), so the
 * upgrade runs it once per repository and refreshes the records it cannot
 * reach in the install record itself, without failing.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../lib/test-helpers/windows-skip.ts";
import { type Machine, machine, SCHEDULERS } from "./lifecycle-fixtures.ts";

const onWindows = skipsOnWindows(
  "powershell",
  "the stand-in agent tools and the platform schedulers are POSIX",
);

interface Report {
  harnesses: {
    harness: string;
    outcome: string;
    scoped?: Record<string, unknown>[];
  }[];
}

interface RecordEntry {
  scope: string;
  projectPath?: string;
  version: string;
  installPath: string;
  gitCommitSha?: string;
}

/** Runs git in `cwd` with the machine's environment, failing the test on an error. */
function git(m: Machine, cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: m.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 0);
}

/** A repository with a second worktree: the two directories. */
function worktrees(m: Machine): { first: string; second: string } {
  const first = join(m.root, "consumer");
  const second = join(m.root, "consumer-pickup");
  mkdirSync(first);
  git(m, first, "init", "-q");
  git(
    m,
    first,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  );
  git(m, first, "worktree", "add", "-q", second);
  return { first, second };
}

/** Writes Claude Code's install record under `config` with these project-scope installs. */
function writeRecord(
  config: string,
  installs: { project: string; version: string }[],
): string {
  const plugins = join(config, "plugins");
  mkdirSync(plugins, { recursive: true });
  const record = join(plugins, "installed_plugins.json");
  writeFileSync(
    record,
    JSON.stringify({
      version: 2,
      plugins: {
        "jig@jig": installs.map(({ project, version }) => ({
          scope: "project",
          projectPath: project,
          installPath: join(config, "cache", version),
          version,
          gitCommitSha: `commit-of-${version}`,
        })),
      },
    }),
  );
  return record;
}

function entries(record: string): RecordEntry[] {
  return (
    JSON.parse(readFileSync(record, "utf8")) as {
      plugins: Record<string, RecordEntry[]>;
    }
  ).plugins["jig@jig"] as RecordEntry[];
}

function claudeOf(result: { stdout: Buffer }) {
  return (JSON.parse(result.stdout.toString()) as Report).harnesses.find(
    (h) => h.harness === "claude",
  );
}

function scopedUpdates(m: Machine): string[] {
  return m
    .agentCalls()
    .filter((call) =>
      call.startsWith("claude plugin update jig@jig --scope project"),
    );
}

test.skipIf(onWindows)(
  "jig upgrade refreshes the worktree Claude Code's update cannot reach in the install record, and exits 0",
  () => {
    const m = machine(SCHEDULERS[0]);
    const { first, second } = worktrees(m);
    const record = writeRecord(join(m.home, ".claude"), [
      { project: first, version: "0.1.0" },
      { project: second, version: "0.1.0" },
    ]);
    m.release("0.3.0", m.plugin);
    const result = m.jig(["upgrade", "--json"]);
    expectSpawnExit(result, 0);
    expect(claudeOf(result)?.scoped).toEqual([
      {
        scope: "project",
        project: first,
        before: "0.1.0",
        version: "0.3.0",
        outcome: "refreshed",
        detail: "0.1.0 → 0.3.0",
      },
      {
        scope: "project",
        project: second,
        before: "0.1.0",
        version: "0.3.0",
        outcome: "rewritten",
        detail: `claude plugin update, run once for its repository from ${first}, refreshed ${first}, not this one; refreshed to 0.3.0 in the install record`,
      },
    ]);
    // One update for the repository, not one per worktree.
    expect(scopedUpdates(m)).toEqual([
      "claude plugin update jig@jig --scope project --json",
    ]);
    const after = entries(record);
    expect(after.map((e) => [e.projectPath, e.version, e.installPath])).toEqual(
      [
        [first, "0.3.0", m.plugin],
        [second, "0.3.0", m.plugin],
      ],
    );
    // The stale commit is not carried over; the record names no user-scope one.
    expect(after[1]?.gitCommitSha).toBeUndefined();
    const err = result.stderr.toString();
    expect(err).toContain(
      `claude: jig@jig 0.1.0 for ${second} (project scope): rewritten, claude plugin update, run once for its repository from ${first}`,
    );

    const doctor = m.jig(["doctor", "--json"]);
    expect(
      (
        JSON.parse(doctor.stdout.toString()) as {
          checks: { id: string; status: string }[];
        }
      ).checks,
    ).toContainEqual(
      expect.objectContaining({ id: "plugin:claude:scopes", status: "pass" }),
    );
  },
);

test.skipIf(onWindows)(
  "jig upgrade refreshes a worktree behind the repository's current first record, which Claude Code reports already up to date",
  () => {
    const m = machine(SCHEDULERS[0]);
    const { first, second } = worktrees(m);
    const record = writeRecord(join(m.home, ".claude"), [
      { project: first, version: "0.2.0" },
      { project: second, version: "0.1.0" },
    ]);
    const result = m.jig(["upgrade", "--json"]);
    expectSpawnExit(result, 0);
    expect(claudeOf(result)?.scoped).toContainEqual(
      expect.objectContaining({
        project: second,
        outcome: "rewritten",
        detail: `claude plugin update from ${second} reaches ${first}, another worktree of the same repository, not this one; refreshed to 0.2.0 in the install record`,
      }),
    );
    expect(entries(record).map((e) => e.version)).toEqual(["0.2.0", "0.2.0"]);
  },
);

test.skipIf(onWindows)(
  "jig upgrade says when Claude Code's update refreshed another directory than the one it ran in, naming both",
  () => {
    const m = machine(SCHEDULERS[0]);
    const ran = join(m.root, "ran-here");
    const reached = join(m.root, "reached-instead");
    for (const dir of [ran, reached]) mkdirSync(dir);
    const record = writeRecord(join(m.home, ".claude"), [
      { project: ran, version: "0.1.0" },
      { project: reached, version: "0.1.0" },
    ]);
    m.release("0.3.0", m.plugin);
    m.agentState((state) => {
      state.claude.scopedUpdateRedirect = reached;
    });
    const result = m.jig(["upgrade", "--json"]);
    expectSpawnExit(result, 0);
    expect(claudeOf(result)?.scoped).toEqual([
      expect.objectContaining({
        project: reached,
        outcome: "refreshed",
        detail: "0.1.0 → 0.3.0",
      }),
      expect.objectContaining({
        project: ran,
        outcome: "rewritten",
        detail: `claude plugin update from ${ran} refreshed ${reached} instead; refreshed to 0.3.0 in the install record`,
      }),
    ]);
    // The directory the first update reached gets no update of its own.
    expect(scopedUpdates(m)).toHaveLength(1);
    expect(entries(record).map((e) => e.version)).toEqual(["0.3.0", "0.3.0"]);
  },
);

test.skipIf(onWindows)(
  "two Claude Code configuration directories sharing one plugins directory refresh its project-scope installs once",
  () => {
    const m = machine(SCHEDULERS[0]);
    const { first, second } = worktrees(m);
    const one = join(m.root, "config-one");
    const two = join(m.root, "config-two");
    const record = writeRecord(one, [
      { project: first, version: "0.1.0" },
      { project: second, version: "0.1.0" },
    ]);
    mkdirSync(two);
    symlinkSync(join(one, "plugins"), join(two, "plugins"));
    m.release("0.3.0", m.plugin);
    const runs = [one, two].map((config) =>
      m.jig(["upgrade", "--claude", "--json"], { CLAUDE_CONFIG_DIR: config }),
    );
    for (const run of runs) expectSpawnExit(run, 0);
    expect(scopedUpdates(m)).toHaveLength(1);
    expect(
      claudeOf(runs[1] as { stdout: Buffer })?.scoped?.map((r) => r.outcome),
    ).toEqual(["unchanged", "unchanged"]);
    expect(entries(record).map((e) => e.version)).toEqual(["0.3.0", "0.3.0"]);
  },
);

test.skipIf(onWindows)(
  "a user-scope install left disabled still fails the upgrade beside refreshed worktrees",
  () => {
    const m = machine(SCHEDULERS[0]);
    const { first, second } = worktrees(m);
    writeRecord(join(m.home, ".claude"), [
      { project: first, version: "0.1.0" },
      { project: second, version: "0.1.0" },
    ]);
    m.release("0.3.0", m.plugin);
    m.agentState((state) => {
      state.claude.enabled = false;
    });
    const result = m.jig(["upgrade", "--claude", "--json"]);
    expectSpawnExit(result, 1);
    const claude = claudeOf(result);
    expect(claude?.outcome).toBe("missing");
    expect(claude?.scoped?.map((r) => r.outcome)).not.toContain("left");
  },
);
