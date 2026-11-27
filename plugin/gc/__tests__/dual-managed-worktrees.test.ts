/**
 * A process-owned worktree that Orca also lists is collectible only when both
 * runtimes' evidence says it is finished. Each scenario runs in a subprocess,
 * since it changes the home directory and the launch database.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** What Orca's registry says of the worktree, and what git holds in it. */
interface Scenario {
  name: string;
  /** The `worktree ps` row's fields beyond its path, or "unreadable" for a failed call. */
  registry:
    | "unreadable"
    | {
        agents: unknown[];
        liveTerminalCount: unknown;
        unverifiableTerminalCount: unknown;
      };
  /** The listing's host coverage, when it is not whole. */
  hostScope?: unknown;
  /** The row Orca reports once the proof is done, before collection starts. */
  later?: Record<string, unknown>;
  /** Work the checkout holds that the runtimes' evidence does not cover. */
  work?: "uncommitted" | "unpushed";
  expect: {
    state: string;
    reason?: string;
    collected: boolean;
    /** The outcome collection answers, when it is reached. */
    outcome?: string;
    /** What the refusal says, when collection is reached and refused. */
    collectedReason?: string;
  };
}

const quiet = {
  agents: [],
  liveTerminalCount: 0,
  unverifiableTerminalCount: 0,
};
const SCENARIOS: Scenario[] = [
  {
    name: "idle owner and no live Orca session: collectible",
    registry: quiet,
    expect: { state: "dead", collected: true },
  },
  {
    name: "a live Orca terminal keeps it",
    registry: { ...quiet, liveTerminalCount: 1 },
    expect: { state: "live", reason: "live terminal", collected: false },
  },
  {
    name: "an agent at work in Orca keeps it",
    registry: { ...quiet, agents: [{ state: "working" }] },
    expect: { state: "live", reason: "agent working", collected: false },
  },
  {
    name: "a terminal Orca cannot report keeps it as unverified",
    registry: { ...quiet, unverifiableTerminalCount: 1 },
    expect: {
      state: "unverified",
      reason:
        "Orca's registry (orca worktree ps) lists 1 terminal(s) whose agents it cannot report",
      collected: false,
    },
  },
  {
    name: "a registry row without terminal counts keeps it as unverified",
    registry: {
      agents: [],
      liveTerminalCount: null,
      unverifiableTerminalCount: null,
    },
    expect: {
      state: "unverified",
      reason: "lists no terminal counts for it",
      collected: false,
    },
  },
  ...[
    ["a string", "1"],
    ["a fraction", 0.5],
    ["a negative number", -1],
  ].map(
    ([what, value]): Scenario => ({
      name: `${what} as a terminal count keeps it as unverified`,
      registry: { ...quiet, liveTerminalCount: value },
      expect: {
        state: "unverified",
        reason: "lists no terminal counts for it",
        collected: false,
      },
    }),
  ),
  {
    name: "a listing that omits a host keeps it as unverified",
    registry: quiet,
    hostScope: { hostIds: ["local"], omittedHostIds: ["remote"] },
    expect: {
      state: "unverified",
      reason: "does not cover every host",
      collected: false,
    },
  },
  {
    name: "a listing naming no host keeps it as unverified",
    registry: quiet,
    hostScope: { hostIds: [], omittedHostIds: [] },
    expect: {
      state: "unverified",
      reason: "does not cover every host",
      collected: false,
    },
  },
  {
    name: "a listing naming an empty host id keeps it as unverified",
    registry: quiet,
    hostScope: { hostIds: [""], omittedHostIds: [] },
    expect: {
      state: "unverified",
      reason: "does not cover every host",
      collected: false,
    },
  },
  {
    name: "a listing naming a non-string host id keeps it as unverified",
    registry: quiet,
    hostScope: { hostIds: [7], omittedHostIds: [] },
    expect: {
      state: "unverified",
      reason: "does not cover every host",
      collected: false,
    },
  },
  {
    name: "a listing without host coverage keeps it as unverified",
    registry: quiet,
    hostScope: null,
    expect: {
      state: "unverified",
      reason: "does not cover every host",
      collected: false,
    },
  },
  {
    name: "a terminal opened after the proof keeps it at collection",
    registry: quiet,
    later: { liveTerminalCount: 1 },
    expect: {
      state: "dead",
      collected: false,
      outcome: "failed",
      collectedReason: "Orca's registry reports 1 live terminal(s)",
    },
  },
  {
    name: "an agent started after the proof keeps it at collection",
    registry: quiet,
    later: { agents: [{ state: "working" }] },
    expect: {
      state: "dead",
      collected: false,
      outcome: "failed",
      collectedReason: "Orca's registry reports an agent working",
    },
  },
  {
    name: "an Orca answer that cannot be read keeps it as unverified, naming Orca",
    registry: "unreadable",
    expect: {
      state: "unverified",
      reason: "Orca's registry (orca worktree ps) could not be read",
      collected: false,
    },
  },
  {
    name: "uncommitted work keeps it whatever the runtimes say",
    registry: quiet,
    work: "uncommitted",
    expect: { state: "live", reason: "uncommitted", collected: false },
  },
  {
    name: "unpushed commits keep it whatever the runtimes say",
    registry: quiet,
    work: "unpushed",
    expect: { state: "live", reason: "ahead of the base", collected: false },
  },
];

function program(root: string, scenario: Scenario): string {
  const plugin = resolve(import.meta.dir, "../..");
  return `
    import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
    import { join } from "node:path";
    import { setupWorktreeFixture } from ${JSON.stringify(join(plugin, "gc/__tests__/worktree-fixture.ts"))};
    import { worktreesKind } from ${JSON.stringify(join(plugin, "gc/kinds/worktrees.ts"))};
    import { processWorktreeRoot, writeWorktreeOwner } from ${JSON.stringify(join(plugin, "shared/process-worktree-owner.ts"))};
    import { stateDb } from ${JSON.stringify(join(plugin, "dispatch/lib/state.ts"))};
    import { ownIdentity } from ${JSON.stringify(join(plugin, "shared/liveness.ts"))};
    const scenario = ${JSON.stringify(scenario)};
    const root = ${JSON.stringify(root)};
    const f = setupWorktreeFixture(root);
    const { repo, command } = f;
    writeFileSync(join(repo, "README"), "x");
    command(["git", "add", "."]); command(["git", "commit", "-m", "initial"]);
    command(["git", "remote", "add", "origin", "fakeforge:acme/app.git"]); command(["git", "push", "origin", "main"]);
    command(["git", "fetch", "origin"]);
    command(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const tree = join(processWorktreeRoot(repo), "topic");
    command(["git", "worktree", "add", "-b", "topic", tree]);
    const admin = command(["git", "-C", tree, "rev-parse", "--git-dir"]);
    for (const [name, body] of [["gh", 'echo "[]"'], ["lsof", "exit 1"]]) {
      writeFileSync(join(f.bin, name), "#!/bin/sh\\n" + body + "\\n"); chmodSync(join(f.bin, name), 0o755);
    }
    const id = "20261114T234948Z-470fe362";
    const owner = { version: 1, runtime: "process", repository: repo, branch: "topic", launches: [id], processes: [] };
    const createdAt = "2026-11-14T23:49:48.000Z";
    const record = { version: 1, runtime: "process", id, token: "token", action: "pickup", repo: "acme/app", repoPath: repo, item: "#1", pr: null, account: "account", vendor: "codex", configDir: root, wallBackoffMs: 1000, replaces: null, facts: "", createdAt, workspace: { id: tree, path: tree }, attempts: [] };
    const identity = ownIdentity();
    const claim = { ...identity, pid: 2147483647, start: "absent", claimedAt: createdAt };
    const exit = { at: createdAt, code: 0, signal: null };
    const db = stateDb();
    db.query("INSERT INTO launches (id, repo, action, item, created_at, record, claim, exit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, record.repo, "pickup", "#1", createdAt, JSON.stringify(record), JSON.stringify(claim), JSON.stringify(exit));
    writeWorktreeOwner(admin, owner);
    if (scenario.work === "uncommitted") writeFileSync(join(tree, "scratch.txt"), "work");
    if (scenario.work === "unpushed") {
      writeFileSync(join(tree, "feature.txt"), "work");
      command(["git", "add", "."], tree); command(["git", "commit", "-m", "work"], tree);
    }
    // Orca lists the worktree; its registry answers as the scenario says.
    const list = { ok: true, result: { truncated: false, worktrees: [{ id: "external", path: tree }] } };
    const ps = scenario.registry === "unreadable" ? null : { ok: true, result: { truncated: false, hostScope: "hostScope" in scenario ? scenario.hostScope : { hostIds: ["local"], omittedHostIds: [] }, worktrees: [{ path: tree, ...scenario.registry }] } };
    writeFileSync(join(root, "list.json"), JSON.stringify(list));
    writeFileSync(join(root, "ps.json"), JSON.stringify(ps));
    const orca = join(f.bin, "orca");
    writeFileSync(orca, '#!/bin/sh\\ncase "$2" in\\nlist) cat ' + JSON.stringify(join(root, "list.json")) + ';;\\nps) ' + (ps === null ? "echo unavailable >&2; exit 1" : "cat " + JSON.stringify(join(root, "ps.json"))) + ';;\\nesac\\n');
    chmodSync(orca, 0o755);
    const tip = command(["git", "rev-parse", "HEAD"]);
    const kind = worktreesKind(repo, [], "base @ " + tip, 0, { remote: "origin", base: "main" }, orca);
    const inventory = await kind.inventory();
    if (!inventory.ok || inventory.value.length !== 1) throw Error("not inventoried: " + JSON.stringify(inventory));
    const resource = inventory.value[0];
    if (resource.details.runtime !== "process" || resource.details.dualManaged !== true) throw Error("not dual managed: " + JSON.stringify(resource));
    const proof = await kind.exclusive(async () => {
      const proof = await kind.prove(resource);
      if (scenario.later) writeFileSync(join(root, "ps.json"), JSON.stringify({ ok: true, result: { truncated: false, hostScope: "hostScope" in scenario ? scenario.hostScope : { hostIds: ["local"], omittedHostIds: [] }, worktrees: [{ path: tree, ...scenario.registry, ...scenario.later }] } }));
      const collected = proof.state === "dead" ? await kind.collect(resource) : null;
      return { proof, collected };
    });
    console.log("RESULT " + JSON.stringify({ state: proof.proof.state, reason: proof.proof.reason, outcome: proof.collected?.outcome ?? null, collectedReason: proof.collected?.reason ?? null, exists: existsSync(tree) }));
  `;
}

for (const scenario of SCENARIOS)
  test.skipIf(
    skipsOnWindows("git-bash", "the fixture remote uses shell scripts"),
  )(
    `a process-owned worktree Orca also lists: ${scenario.name}`,
    () => {
      const root = mkdtempSync(join(tmpdir(), "gc-dual-"));
      roots.push(root);
      const config = join(root, "bunfig.toml");
      writeFileSync(config, "");
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          `--config=${config}`,
          "-e",
          program(root, scenario),
        ],
        {
          env: {
            ...process.env,
            HOME: join(root, "home"),
            USERPROFILE: join(root, "home"),
            JIG_HOME: join(root, "home/.jig"),
            JIG_USER_LAYER: "off",
            JIG_OVERLAY: undefined,
            RESOURCE_LOCK_BYPASS: "1",
            PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 60_000,
        },
      );
      expectSpawnExit(child, 0);
      const line = child.stdout
        .toString()
        .split("\n")
        .find((one) => one.startsWith("RESULT "));
      const got = JSON.parse((line ?? "RESULT null").slice(7)) as {
        state: string;
        reason: string;
        outcome: string | null;
        collectedReason: string | null;
        exists: boolean;
      };
      const label = `${scenario.name}: ${JSON.stringify(got)}`;
      expect(got.state, label).toBe(scenario.expect.state);
      if (scenario.expect.reason !== undefined)
        expect(got.reason, label).toContain(scenario.expect.reason);
      expect(got.outcome === "collected", label).toBe(
        scenario.expect.collected,
      );
      if (scenario.expect.outcome !== undefined)
        expect(got.outcome, label).toBe(scenario.expect.outcome);
      if (scenario.expect.collectedReason !== undefined)
        expect(got.collectedReason, label).toContain(
          scenario.expect.collectedReason,
        );
      expect(got.exists, label).toBe(!scenario.expect.collected);
    },
    60_000,
  );
