/**
 * The converged CI watch asks ownership immediately before each durable
 * write: the label re-run's claim and the `converged-ci` park. Each probe
 * runs in a subprocess with its own state directory, a neutral park recipient
 * and a forge that fails if it is called; the driver's own variables are
 * scrubbed. The owner is read from a file at the moment it is asked, so a test
 * can change it while the write waits.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const root = join(import.meta.dir, "../scripts/lib");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "converged-ci-ownership-"));
  const consumer = join(dir, "consumer");
  const bin = join(dir, "bin");
  mkdirSync(join(consumer, ".config"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    "dispatch:\n  person: owner-person\n",
  );
  const forge = join(bin, "gh");
  writeFileSync(
    forge,
    `#!/usr/bin/env bun
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "forge-called"))}, "");
process.exit(1);
`,
  );
  chmodSync(forge, 0o755);
  const ownerFile = join(dir, "owner");
  const dbFile = join(dir, "state", "state.sqlite");
  const source = join(dir, "probe.ts");
  writeFileSync(
    source,
    `
    import { existsSync, readFileSync } from "node:fs";
    import { liveConvergedCi, parkConvergedCi } from ${JSON.stringify(join(root, "driver/converged-ci-live.ts"))};
    import { openStore } from ${JSON.stringify(join(root, "state/store.ts"))};
    const [mode] = process.argv.slice(2);
    let askedWithDatabase = null;
    const owned = async () => {
      askedWithDatabase = existsSync(${JSON.stringify(dbFile)});
      const owner = readFileSync(${JSON.stringify(ownerFile)}, "utf8").trim();
      if (owner === "throws") throw new Error("claims did not read");
      return owner;
    };
    if (mode === "claim") {
      const deps = liveConvergedCi(1, owned);
      const ok = await deps.claimRerun("5", { id: 7, attempt: 1 });
      console.log(JSON.stringify({ ok, askedWithDatabase }));
    } else {
      const ok = await parkConvergedCi("5", "CI unsettled", false, owned);
      const parked = (await openStore("5")).read().state.parked.length;
      console.log(JSON.stringify({ ok, parked }));
    }
  `,
  );
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("DRIVE_PR_") && !key.startsWith("JIG__"),
    ),
  );
  Object.assign(env, {
    DRIVE_PR_STATE_DIR: join(dir, "state"),
    JIG_USER_LAYER: "off",
    JIG_OVERLAY: join(consumer, ".config", "jig.yaml"),
    JIG_CONSUMER_ROOT: consumer,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  });
  const start = (mode: string, owner: string, extra: object = {}) => {
    writeFileSync(ownerFile, owner);
    return Bun.spawn([process.execPath, source, mode], {
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
  };
  const finish = async (child: ReturnType<typeof start>) => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(existsSync(join(dir, "forge-called"))).toBe(false);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
  };
  const run = async (mode: string, owner: string) => finish(start(mode, owner));
  /** Starts a park whose lock is held open, flips the owner while it waits, and reads the result. */
  const parkLostWhileWaiting = async () => {
    const signal = join(dir, "lock-held");
    const child = start("park", "ours", {
      DRIVE_PR_UPDATE_TEST_DELAY: "2",
      DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(signal) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(signal)).toBe(true);
    writeFileSync(ownerFile, "lost");
    return finish(child);
  };
  return { dir, run, parkLostWhileWaiting };
}

describe("the converged CI watch's durable writes ask ownership first", () => {
  test("a label re-run claim refused for lost or unreadable ownership spends no allowance", async () => {
    const f = fixture();
    try {
      for (const owner of ["lost", "unreadable", "throws"])
        expect((await f.run("claim", owner)).ok).toBe(false);
      const claimed = await f.run("claim", "ours");
      expect(claimed.ok).toBe(true);
      expect((await f.run("claim", "ours")).ok).toBe(false);
      // Asked after the state database was resolved, as the claim commits.
      expect(claimed.askedWithDatabase).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a park refused for lost or unreadable ownership records nothing", async () => {
    const f = fixture();
    try {
      for (const owner of ["lost", "unreadable", "throws"])
        expect(await f.run("park", owner)).toEqual({ ok: false, parked: 0 });
      expect(await f.run("park", "ours")).toEqual({ ok: true, parked: 1 });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("a park whose ownership is lost while it waits for the state lock records nothing", async () => {
    const f = fixture();
    try {
      expect(await f.parkLostWhileWaiting()).toEqual({ ok: false, parked: 0 });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
