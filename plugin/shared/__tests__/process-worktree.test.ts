import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

import { openProcessWorktree } from "../process-worktree.ts";
import { fakeContext } from "./fake-context.ts";
import { ok } from "../outcome.ts";

test("an invalid launch is refused before any command or publication", async () => {
  let published = false;
  const result = await openProcessWorktree(
    {
      host: fakeContext({}),
      runHook: () => {
        expect.unreachable("an invalid launch must not run a create hook");
      },
    },
    { repository: resolve("/repo"), branch: "topic", launch: "../invalid" },
    () => {
      published = true;
      return ok(undefined);
    },
  );
  expect(result).toMatchObject({
    ok: false,
    failure: { code: "invalid-launch" },
  });
  expect(published).toBe(false);
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("plain worktrees keep branch identity, upstream and shared admission through publication", () => {
  const root = mkdtempSync(join(tmpdir(), "process-worktree-"));
  roots.push(root);
  const config = join(root, "bunfig.toml");
  writeFileSync(config, "");
  const shared = resolve(import.meta.dir, "..");
  const program = `
    import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import { openProcessWorktree } from ${JSON.stringify(join(shared, "process-worktree.ts"))};
    import { localContext } from ${JSON.stringify(join(shared, "orca-workspace/runner.ts"))};
    import { boundedHook } from ${JSON.stringify(join(shared, "orca-workspace/port.ts"))};
    import { exclusiveGcLock } from ${JSON.stringify(join(shared, "gc-lock.ts"))};
    import { ok } from ${JSON.stringify(join(shared, "outcome.ts"))};
    import { readWorktreeOwner } from ${JSON.stringify(join(shared, "process-worktree-owner.ts"))};
    const root = ${JSON.stringify(root)};
    const repo = join(root, "repo"), remote = join(root, "remote.git");
    mkdirSync(repo);
    const ctx = localContext(() => {});
    const run = (...args) => { const done = ctx.run(args); if (done.status !== 0) throw Error(done.stderr); return done.stdout.trim(); };
    run("git", "init", "--bare", remote);
    run("git", "-C", repo, "init", "--initial-branch=main");
    run("git", "-C", repo, "config", "user.email", "test@example.invalid");
    run("git", "-C", repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "tracked"), "content");
    run("git", "-C", repo, "add", "."); run("git", "-C", repo, "commit", "-m", "initial");
    run("git", "-C", repo, "remote", "add", "origin", remote);
    run("git", "-C", repo, "push", "origin", "main");
    run("git", "-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    run("git", "-C", repo, "branch", "topic"); run("git", "-C", repo, "push", "origin", "topic"); run("git", "-C", repo, "branch", "-D", "topic");
    const port = { host: ctx, runHook: boundedHook };
    const seen = [];
    const publish = async (tree) => {
      const admin = run("git", "-C", tree.path, "rev-parse", "--git-dir");
      if (!readWorktreeOwner(admin).value) throw Error("owner not published");
      let refused = false;
      try { await exclusiveGcLock("worktrees", async () => {}); } catch { refused = true; }
      if (!refused) throw Error("collection entered during publication");
      seen.push(tree.path); return ok(undefined);
    };
    for (const launch of ["20261114T234948Z-470fe362", "20261114T234949Z-470fe362"]) {
      const answer = await openProcessWorktree(port, { repository: repo, branch: "topic", launch, createHook: false }, publish);
      if (!answer.ok) throw Error(answer.failure.reason);
      if (run("git", "-C", answer.value.worktree.path, "symbolic-ref", "--short", "HEAD") !== "topic") throw Error("detached branch");
      if (run("git", "-C", answer.value.worktree.path, "rev-parse", "--abbrev-ref", "@{upstream}") !== "origin/topic") throw Error("wrong upstream");
    }
    if (seen[0] !== seen[1]) throw Error("duplicate worktree");
    const admin = run("git", "-C", seen[0], "rev-parse", "--git-dir");
    const ownerPath = join(admin, "jig-process-owner.json");
    rmSync(ownerPath); mkdirSync(ownerPath);
    const unreadable = await openProcessWorktree(port, { repository: repo, branch: "topic", launch: "20261114T234950Z-470fe362", createHook: false }, publish);
    if (unreadable.ok || unreadable.failure.cause?.cause?.code !== "owner-unreadable") throw Error("read failure cause lost");
    rmSync(ownerPath, { recursive: true });
    const writePort = { ...port, host: { ...ctx, run: (argv, options) => argv.at(-1) === "--absolute-git-dir" ? { status: 0, stdout: join(root, "absent", "admin"), stderr: "" } : ctx.run(argv, options) } };
    const unwritable = await openProcessWorktree(writePort, { repository: repo, branch: "failure", launch: "20261114T234951Z-470fe362", createHook: false }, publish);
    if (unwritable.ok || unwritable.failure.cause?.cause?.code !== "ENOENT") throw Error("write failure cause lost");

    await exclusiveGcLock("worktrees", async () => {});
    console.log(JSON.stringify(seen));
  `;
  const child = Bun.spawnSync(
    [process.execPath, "--no-env-file", `--config=${config}`, "-e", program],
    {
      env: {
        ...process.env,
        HOME: join(root, "home"),
        USERPROFILE: join(root, "home"),
        JIG_HOME: join(root, "jig"),
        JIG_USER_LAYER: "off",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
  expectSpawnExit(child, 0);
  expect(JSON.parse(child.stdout.toString())).toHaveLength(2);
}, 60_000);
