/**
 * The converged CI watch asks ownership immediately before each durable
 * write: the label re-run's claim and the `converged-ci` park. Each probe
 * runs in a subprocess with its own state directory.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const root = join(import.meta.dir, "../scripts/lib");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "converged-ci-ownership-"));
  const source = join(dir, "probe.ts");
  writeFileSync(
    source,
    `
    import { liveConvergedCi, parkConvergedCi } from ${JSON.stringify(join(root, "driver/converged-ci-live.ts"))};
    const [mode, owner] = process.argv.slice(2);
    const owned = owner === "none" ? undefined : async () => {
      if (owner === "throws") throw new Error("claims did not read");
      return owner;
    };
    if (mode === "claim") {
      const deps = liveConvergedCi(1, owned);
      console.log(JSON.stringify(await deps.claimRerun("5", { id: 7, attempt: 1 })));
    } else {
      console.log(JSON.stringify(await parkConvergedCi("5", "CI unsettled", false, owned)));
    }
  `,
  );
  const env = { ...process.env, DRIVE_PR_STATE_DIR: join(dir, "state") };
  const run = async (mode: string, owner: string) => {
    const child = Bun.spawn([process.execPath, source, mode, owner], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
  };
  return { dir, run };
}

describe("the converged CI watch's durable writes ask ownership first", () => {
  test("a label re-run claim refused for lost or unreadable ownership spends no allowance", async () => {
    const f = fixture();
    try {
      expect(await f.run("claim", "lost")).toBe(false);
      expect(await f.run("claim", "unreadable")).toBe(false);
      expect(await f.run("claim", "throws")).toBe(false);
      expect(await f.run("claim", "ours")).toBe(true);
      expect(await f.run("claim", "ours")).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a park refused for lost or unreadable ownership records nothing", async () => {
    const f = fixture();
    try {
      expect(await f.run("park", "lost")).toBe(false);
      expect(await f.run("park", "unreadable")).toBe(false);
      expect(await f.run("park", "throws")).toBe(false);
      expect(await f.run("park", "ours")).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
