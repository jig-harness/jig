import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test.skipIf(
  skipsOnWindows(
    "git-bash",
    "the fixture remote and remove hook use shell scripts",
  ),
)(
  "process trees need ended launches and dead identities, rechecked after the remove hook",
  () => {
    const root = mkdtempSync(join(tmpdir(), "gc-process-"));
    roots.push(root);
    const config = join(root, "bunfig.toml");
    writeFileSync(config, "");
    const plugin = resolve(import.meta.dir, "../..");
    const program = `
    import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
    import { join } from "node:path";
    import { setupWorktreeFixture } from ${JSON.stringify(join(plugin, "gc/__tests__/worktree-fixture.ts"))};
    import { worktreesKind } from ${JSON.stringify(join(plugin, "gc/kinds/worktrees.ts"))};
    import { processWorktreeRoot, writeWorktreeOwner } from ${JSON.stringify(join(plugin, "shared/process-worktree-owner.ts"))};
    import { stateDb } from ${JSON.stringify(join(plugin, "dispatch/lib/state.ts"))};
    import { ownIdentity } from ${JSON.stringify(join(plugin, "shared/liveness.ts"))};
    const root = ${JSON.stringify(root)};
    const f = setupWorktreeFixture(root);
    const { repo, command } = f;
    const flag = join(root, "damage-owner");
    mkdirSync(join(repo, ".config/worktree-hooks"), { recursive: true });
    const hook = join(repo, ".config/worktree-hooks/remove");
    writeFileSync(hook, '#!/bin/sh\\nif [ -f ' + JSON.stringify(flag) + ' ]; then printf malformed > "$(git rev-parse --git-dir)/jig-process-owner.json"; fi\\n'); chmodSync(hook, 0o755);
    command(["git", "add", "."]); command(["git", "commit", "-m", "initial"]);
    command(["git", "remote", "add", "origin", "fakeforge:acme/app.git"]); command(["git", "push", "origin", "main"]);
    command(["git", "fetch", "origin"]);
    command(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const tree = join(processWorktreeRoot(repo), "topic");
    command(["git", "worktree", "add", "-b", "topic", tree]);
    const admin = command(["git", "-C", tree, "rev-parse", "--git-dir"]);
    writeFileSync(join(f.bin, "gh"), '#!/bin/sh\\necho "[]"\\n'); chmodSync(join(f.bin, "gh"), 0o755);
    writeFileSync(join(f.bin, "lsof"), '#!/bin/sh\\nexit 1\\n'); chmodSync(join(f.bin, "lsof"), 0o755);
    const id = "20261114T234948Z-470fe362";
    const owner = { version: 1, runtime: "process", repository: repo, branch: "topic", launches: [id], processes: [] };
    const record = { version: 1, id, token: "token", action: "pickup", repo: "acme/app", repoPath: repo, item: "#1", pr: null, account: "account", vendor: "codex", configDir: root, wallBackoffMs: 1000, replaces: null, facts: "", createdAt: "2026-11-14T23:49:48.000Z", workspace: { id: tree, path: tree }, attempts: [] };
    const db = stateDb();
    const identity = ownIdentity();
    const dead = { ...identity, pid: 2147483647, start: "absent" };
    const claim = { ...dead, claimedAt: record.createdAt };
    const exit = { at: record.createdAt, code: 0, signal: null };
    db.query("INSERT INTO launches (id, repo, action, item, created_at, record, claim, exit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, record.repo, "pickup", "#1", record.createdAt, JSON.stringify(record), JSON.stringify(claim), JSON.stringify(exit));
    writeWorktreeOwner(admin, owner);
    const tip = command(["git", "rev-parse", "HEAD"]);
    const orca = join(f.bin, "orca");
    const orcaList = { ok: true, result: { truncated: false, worktrees: [{ id: "external", path: tree }] } };
    writeFileSync(orca, '#!/bin/sh\\necho ' + JSON.stringify(JSON.stringify(orcaList)) + '\\n'); chmodSync(orca, 0o755);
    const overlap = worktreesKind(repo, [], "base @ " + tip, 0, { remote: "origin", base: "main" }, orca);
    rmSync(join(admin, "jig-process-owner.json"));
    db.query("UPDATE launches SET exit = NULL, claim = ? WHERE id = ?").run(JSON.stringify({ ...identity, claimedAt: record.createdAt }), id);
    const missingOwnerInventory = await overlap.inventory();
    if (!missingOwnerInventory.ok || missingOwnerInventory.value[0].details.runtime !== "process") throw Error("missing owner let Orca overwrite process root ownership");
    const missingOwnerTree = missingOwnerInventory.value[0];
    const missingOwnerProof = await overlap.prove(missingOwnerTree);
    if (missingOwnerProof.state !== "unverified") throw Error("missing owner was not kept");
    const missingOwnerCollect = await overlap.collect(missingOwnerTree);
    if (missingOwnerCollect.outcome !== "failed" || !existsSync(tree)) throw Error("missing owner reached Orca collection");
    const processOnly = worktreesKind(repo, [], "base @ " + tip, 0, { remote: "origin", base: "main" });
    const processOnlyInventory = await processOnly.inventory();
    if (!processOnlyInventory.ok || processOnlyInventory.value[0].details.runtime !== "process") throw Error("process root without owner was not classified");
    const processOnlyProof = await processOnly.prove(processOnlyInventory.value[0]);
    if (processOnlyProof.state !== "unverified" || !processOnlyProof.reason.includes("owner record is missing")) throw Error("missing process owner did not fail proof");
    db.query("UPDATE launches SET exit = ?, claim = ? WHERE id = ?").run(JSON.stringify(exit), JSON.stringify(claim), id);
    writeWorktreeOwner(admin, owner);
    const overlapInventory = await overlap.inventory();
    if (!overlapInventory.ok || overlapInventory.value[0].details.runtime !== "process") throw Error("Orca overwrote process ownership");
    const overlapTree = overlapInventory.value[0];
    const refusedOverlap = async () => { const proof = await overlap.prove(overlapTree); if (proof.state !== "unverified" || !proof.reason.includes("also listed by Orca")) throw Error("dual management did not refuse: " + JSON.stringify(proof)); };
    await refusedOverlap();
    const kind = worktreesKind(repo, [], "base @ " + tip, 0, { remote: "origin", base: "main" });
    const inventory = await kind.inventory(); if (!inventory.ok || inventory.value.length !== 1) throw Error("runs root not inventoried");
    const resource = inventory.value[0];
    if (resource.details.runtime !== "process") throw Error("not process runtime");
    const prove = async (state) => { const proof = await kind.prove(resource); if (proof.state !== state) throw Error(JSON.stringify(proof)); return proof; };
    await prove("dead");
    db.query("UPDATE launches SET exit = NULL WHERE id = ?").run(id); await prove("unverified"); await refusedOverlap();
    db.query("UPDATE launches SET exit = ?, claim = ? WHERE id = ?").run(JSON.stringify(exit), JSON.stringify({ ...identity, claimedAt: record.createdAt }), id); await prove("unverified"); await refusedOverlap();
    db.query("UPDATE launches SET claim = ? WHERE id = ?").run(JSON.stringify(claim), id);
    const extra = { ...record, id: "20261114T234949Z-470fe362" };
    db.query("INSERT INTO launches (id, repo, action, item, created_at, record) VALUES (?, ?, ?, ?, ?, ?)").run(extra.id, extra.repo, "pickup", "#1", record.createdAt, JSON.stringify(extra)); await prove("unverified");
    db.query("DELETE FROM launches WHERE id = ?").run(extra.id);
    writeFileSync(join(admin, "jig-process-owner.json"), "malformed"); await prove("unverified");
    writeWorktreeOwner(admin, owner); await prove("dead");
    writeFileSync(flag, "");
    const refused = await kind.exclusive(async () => { await prove("dead"); return kind.collect(resource); });
    if (refused.outcome !== "failed" || !existsSync(tree)) throw Error("owner change during hook was not refused: " + JSON.stringify(refused));
    rmSync(flag); writeWorktreeOwner(admin, owner);
    const collected = await kind.exclusive(async () => { await prove("dead"); return kind.collect(resource); });
    if (collected.outcome !== "collected" || existsSync(tree)) throw Error(JSON.stringify(collected));
    console.log("collected with final owner proof");
  `;
    const child = Bun.spawnSync(
      [process.execPath, "--no-env-file", `--config=${config}`, "-e", program],
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
    expect(child.stdout.toString()).toContain(
      "collected with final owner proof",
    );
  },
  60_000,
);
