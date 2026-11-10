import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { claimLockKey } from "../scripts/tracker.ts";

test("uses the resolved tracker namespace in a claim lock key", () => {
  expect(
    claimLockKey({ adapter: "github", team: "jig-harness/jig" }, "#12"),
  ).toBe("github:jig-harness/jig:#12");
  expect(
    claimLockKey({ adapter: "github", team: "another/repository" }, "#12"),
  ).not.toBe("github:jig-harness/jig:#12");
});

test("claims in different worktrees share the host lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "jig-claim-lock-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const entered = join(root, "entered");
  const released = join(root, "released");
  const source = resolve(import.meta.dir, "../scripts/lib/claim-lock.ts");
  const script = join(root, "run.ts");
  await Bun.write(
    script,
    `
    import { withClaimLock } from ${JSON.stringify(source)};
    const [mode,entered,released] = process.argv.slice(2);
    const result = await withClaimLock("#1", async () => {
      if (mode === "holder") {
        await Bun.write(entered,"ready");
        const deadline = Date.now() + 15000;
        while (!(await Bun.file(released).exists())) {
          if (Date.now() >= deadline) throw new Error("release deadline exceeded");
          await new Promise(done => setTimeout(done,25));
        }
      }
      return {outcome:"claimed",issue:"#1",claimant:{id:"person",name:"person"},state:"In Progress"};
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.outcome === "refused" ? 3 : 0;
  `,
  );
  const run = (mode: string, cwd: string) =>
    Bun.spawn([process.execPath, script, mode, entered, released], {
      cwd,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      stdout: "pipe",
      stderr: "pipe",
    });
  const holder = run("holder", first);
  try {
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(entered).exists())) {
      if (Date.now() >= deadline)
        throw new Error("holder did not enter before deadline");
      await new Promise((done) => setTimeout(done, 25));
    }
    const waiter = run("waiter", second);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(waiter.stdout).text(),
      new Response(waiter.stderr).text(),
      waiter.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 3);
    expect(JSON.parse(stdout).outcome).toBe("refused");
    await Bun.write(released, "release");
    const [out, err, code] = await Promise.all([
      new Response(holder.stdout).text(),
      new Response(holder.stderr).text(),
      holder.exited,
    ]);
    expectSpawnExit({ stdout: out, stderr: err, exitCode: code }, 0);
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
