import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stateDb } from "../../dispatch/lib/state.ts";
import { gitEnvironment } from "../git.ts";

export const FIXTURE_REMOTE = "fakeforge:acme/app.git";

/** The common local repository and fake forge that worktree fixtures use. */
export function setupWorktreeFixture(root: string) {
  const repo = join(root, "repo");
  const user = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [repo, user, bin, join(root, "forge", "acme")])
    mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    HOME: user,
    USERPROFILE: user,
    JIG_HOME: join(user, ".jig"),
    JIG_USER_LAYER: undefined,
    JIG_CONSUMER_ROOT: undefined,
    JIG_GC_HEAVY_LOCK: undefined,
    RESOURCE_LOCK_BYPASS: "1",
    ORCA_CLI_COMMAND: undefined,
    ORCA_CLI_BIN_DIR: undefined,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const command = (args: string[], cwd = repo): string => {
    const result = Bun.spawnSync(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
    return result.stdout.toString().trim();
  };
  const ssh = join(bin, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncd ${JSON.stringify(join(root, "forge"))} && exec sh -c "$last"\n`,
  );
  chmodSync(ssh, 0o755);
  command(["git", "init", "--bare", join(root, "forge", "acme", "app.git")]);
  command(["git", "init", "--initial-branch=main"]);
  command(["git", "config", "user.email", "test@example.invalid"]);
  command(["git", "config", "user.name", "Test"]);
  command(["git", "config", "core.sshCommand", ssh]);
  return { repo, user, bin, env, command };
}

/** Seed completion evidence a collector must retire with its worktree. */
export function preserveCompletion(fixture: {
  repo: string;
  tree: string;
  env: NodeJS.ProcessEnv;
}): () => unknown[] {
  const record = {
    version: 1,
    id: "20261115T000000Z-aaaaaaaa",
    token: "token",
    action: "pickup",
    repo: "acme/app",
    repoPath: fixture.repo,
    item: "#1",
    pr: null,
    account: "account",
    vendor: "codex",
    configDir: fixture.repo,
    wallBackoffMs: 1000,
    replaces: null,
    facts: "",
    createdAt: "2026-11-15T00:00:00.000Z",
    workspace: { id: fixture.tree, path: fixture.tree },
    attempts: [],
  };
  const db = stateDb(
    join(fixture.env.HOME as string, ".local", "state", "jig", "dispatch"),
  );
  db.query(
    "INSERT INTO process_worktree_completions (id, record, claim, exit) VALUES (?, ?, ?, ?)",
  ).run(record.id, JSON.stringify(record), "{}", "{}");
  return () => db.query("SELECT id FROM process_worktree_completions").all();
}
