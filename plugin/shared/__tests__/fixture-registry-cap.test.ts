import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { exclusiveFixtureGcLock, sharedGcLock } from "../gc-lock.ts";
import { encodeIdentity, ownIdentity } from "../liveness.ts";
import { testFixtureRegistryRoot } from "../fixture-registry-index.ts";

const registry = import.meta.resolve("../test-fixture-registry.ts");
const index = import.meta.resolve("../fixture-registry-index.ts");

test("registration at the cap retires dead entries and refuses a store of live entries", () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-"));
  try {
    const env = { ...process.env, JIG_TEST_FIXTURE_REGISTRY_LIMIT: "2" };
    const setup = `
      import { registerFixtureScope } from ${JSON.stringify(registry)};
      import { join } from "node:path";
      const base = ${JSON.stringify(base)};
      const store = join(base, "registries");
      function register(name) {
        return registerFixtureScope(join(base, name), undefined, store);
      }
    `;
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `${setup}
        if (!register("exited").ok) process.exit(8);
      `,
      ],
      { env, stderr: "pipe" },
    );
    expectSpawnExit(child, 0);
    const writes = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `${setup}
        import { fixtureRegistryUsage } from ${JSON.stringify(index)};
        const a = register("first");
        const b = register("second");
        const c = register("third");
        const usage = fixtureRegistryUsage(store);
        console.log(JSON.stringify({ a, b, c, usage }));
      `,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(writes, 0);
    expect(JSON.parse(writes.stdout.toString())).toMatchObject({
      a: { ok: true },
      b: { ok: true },
      c: {
        ok: false,
        failure: {
          code: "fixture-registry-full",
          reason: expect.stringContaining("2"),
        },
      },
      usage: { ok: true, value: { count: 2, limit: 2 } },
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("concurrent writers share the cap on a new store", async () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-race-"));
  try {
    const store = join(base, "registries");
    const env = { ...process.env, JIG_TEST_FIXTURE_REGISTRY_LIMIT: "4" };
    const writers = Array.from({ length: 16 }, (_, i) => {
      const root = join(base, `live-${i}`);
      mkdirSync(root);
      return Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `import { registerFixtureScope } from ${JSON.stringify(registry)};
          const result = registerFixtureScope(${JSON.stringify(root)}, undefined, ${JSON.stringify(store)});
          console.log(result.ok ? "registered" : result.failure.code);
          if (!result.ok && result.failure.code !== "fixture-registry-full") {
            console.error(result.failure.reason);
            process.exitCode = 1;
          }`,
        ],
        { env, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
      );
    });
    const results = await Promise.all(
      writers.map(async (writer) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          writer.exited,
          writer.stdout.text(),
          writer.stderr.text(),
        ]);
        return { exitCode, stdout, stderr };
      }),
    );
    const outcomes = results.map((result) => {
      expectSpawnExit(result, 0);
      return result.stdout.trim();
    });
    expect(outcomes.filter((outcome) => outcome === "registered")).toHaveLength(
      4,
    );
    expect(
      outcomes.filter((outcome) => outcome === "fixture-registry-full"),
    ).toHaveLength(12);
    expect(readdirSync(store)).toHaveLength(4);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("inline retirement upgrades nested readers but never another isolate's reader", async () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-lock-"));
  try {
    const lock = import.meta.resolve("../gc-lock.ts");
    const source = join(base, "reader.ts");
    writeFileSync(
      source,
      `
      import { parentPort } from "node:worker_threads";
      import { sharedGcLock } from ${JSON.stringify(lock)};
      const release = sharedGcLock("scratch", ${JSON.stringify(base)});
      parentPort.once("message", () => {
        release();
        parentPort.postMessage("released");
      });
      parentPort.postMessage(process.pid);
    `,
    );
    const outer = sharedGcLock("scratch", base);
    const inner = sharedGcLock("scratch", base);
    try {
      const worker = new Worker(source);
      try {
        expect(await once(worker, "message")).toEqual([process.pid]);
        let deleted = false;
        const collect = () => {
          deleted = true;
        };
        expect(() => exclusiveFixtureGcLock(base, collect)).toThrow(
          "another creator holds the lock",
        );
        expect(deleted).toBe(false);
        const released = once(worker, "message");
        worker.postMessage("release");
        expect(await released).toEqual(["released"]);
        exclusiveFixtureGcLock(base, collect);
        expect(deleted).toBe(true);
      } finally {
        await worker.terminate();
      }
    } finally {
      inner();
      outer();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function fixtureChild(
  source: string,
  home: string,
  env: Record<string, string> = {},
) {
  return Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
}

async function fixtureChildResult(child: ReturnType<typeof fixtureChild>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout.text(),
    child.stderr.text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForScopeRoots(
  scratch: string,
  count: number,
): Promise<void> {
  const deadline = performance.now() + 5000;
  while (readdirSync(scratch).length < count) {
    if (performance.now() >= deadline)
      throw new Error("The scratch roots did not open");
    await Bun.sleep(5);
  }
}

test("normal scratch callers queued on the index can reclaim at capacity", async () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-caller-race-"));
  try {
    const scratch = join(base, "scratch");
    mkdirSync(scratch);
    const store = testFixtureRegistryRoot(base);
    const env = {
      JIG_TEST_FIXTURE_REGISTRY_LIMIT: "2",
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
    };
    const seed = fixtureChild(
      `
      import { registerFixtureScope } from ${JSON.stringify(registry)};
      for (const root of ["first", "second"]) {
        const result = registerFixtureScope(${JSON.stringify(base)} + "/gone-" + root);
        if (!result.ok) throw Error(result.failure.reason);
      }
    `,
      base,
      env,
    );
    expectSpawnExit(await fixtureChildResult(seed), 0);
    const scopeModule = import.meta.resolve("../../../lib/test-tmpdir.ts");
    const db = new Database(`${store}.index.sqlite`, { create: false });
    db.exec("BEGIN IMMEDIATE");
    const writers = Array.from({ length: 2 }, () =>
      fixtureChild(
        `
      delete process.env.JIG_TEST_FIXTURE_REGISTRY;
      delete process.env.JIG_TEST_FIXTURE_NODE;
      const { scopeTestTmpdir } = await import(${JSON.stringify(scopeModule)});
      const scope = scopeTestTmpdir({ fixtureStartup: true });
      console.log("created");
      scope.release();
    `,
        base,
        env,
      ),
    );
    try {
      try {
        await waitForScopeRoots(scratch, writers.length);
      } finally {
        db.exec("ROLLBACK");
        db.close();
      }
      const results = await Promise.all(writers.map(fixtureChildResult));
      for (const result of results) {
        expectSpawnExit(result, 0);
        expect(result.stdout.trim()).toBe("created");
        expect(result.stderr).not.toContain("the scope remains report-only");
      }
      expect(readdirSync(store)).toHaveLength(2);
    } finally {
      await Promise.all(writers.map((writer) => writer.exited));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a legacy scratch reader excludes fresh census and name publication", async () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-legacy-writer-"));
  try {
    const store = testFixtureRegistryRoot(base);
    const lockRoot = join(base, ".local", "state", "jig", "gc-locks");
    const register = `
      import { registerFixtureScope } from ${JSON.stringify(registry)};
      const result = registerFixtureScope(${JSON.stringify(join(base, "gone"))});
      console.log(result.ok ? "registered" : result.failure.code);
    `;
    const env = { JIG_TEST_FIXTURE_REGISTRY_LIMIT: "1" };
    const releaseLegacy = sharedGcLock("scratch", lockRoot);
    try {
      const blocked = await fixtureChildResult(
        fixtureChild(register, base, env),
      );
      expectSpawnExit(blocked, 0);
      expect(blocked.stdout.trim()).toBe("fixture-admission-busy");
      mkdirSync(join(store, "legacy"), { recursive: true });
    } finally {
      releaseLegacy();
    }
    const capped = await fixtureChildResult(fixtureChild(register, base, env));
    expectSpawnExit(capped, 0);
    expect(capped.stdout.trim()).toBe("fixture-registry-full");
    expect(readdirSync(store)).toEqual(["legacy"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 25_000);

test("fresh admission recovers only dead fixture-publisher writers and leaves dead reader tokens", () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-dead-lock-"));
  try {
    const dir = join(base, "scratch");
    mkdirSync(dir);
    const dead = { ...ownIdentity(), pid: 2_147_483_647 };
    const reader = join(dir, `reader-${dead.pid}-old`);
    const writer = join(dir, "writer");
    writeFileSync(reader, encodeIdentity(dead));
    writeFileSync(writer, encodeIdentity(dead));
    let acquired = false;
    const collect = () => {
      acquired = true;
    };
    expect(() => exclusiveFixtureGcLock(base, collect)).toThrow(
      "remove it after inspection",
    );
    expect(acquired).toBe(false);
    expect(existsSync(writer)).toBe(true);
    writeFileSync(
      writer,
      JSON.stringify({ ...dead, fixturePublisher: crypto.randomUUID() }),
    );
    exclusiveFixtureGcLock(base, collect);
    expect(acquired).toBe(true);
    expect(existsSync(writer)).toBe(false);
    expect(existsSync(reader)).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a fresh scratch scope remains usable when the registry is already above its cap", async () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-report-only-"));
  try {
    const store = testFixtureRegistryRoot(base);
    for (const name of ["legacy-a", "legacy-b"])
      mkdirSync(join(store, name), { recursive: true });
    const scopeModule = import.meta.resolve("../../../lib/test-tmpdir.ts");
    const child = await fixtureChildResult(
      fixtureChild(
        `
      delete process.env.JIG_TEST_FIXTURE_REGISTRY;
      delete process.env.JIG_TEST_FIXTURE_NODE;
      const { scopeTestTmpdir } = await import(${JSON.stringify(scopeModule)});
      const scope = scopeTestTmpdir({ fixtureStartup: true });
      console.log("working");
      scope.release();
    `,
        base,
        { JIG_TEST_FIXTURE_REGISTRY_LIMIT: "1" },
      ),
    );
    expectSpawnExit(child, 0);
    expect(child.stdout.trim()).toBe("working");
    expect(child.stderr).toContain("bound of 1");
    expect(child.stderr).toContain("the scope remains report-only");
    expect(readdirSync(store).sort()).toEqual(["legacy-a", "legacy-b"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a fresh scratch scope remains report-only beside a dead legacy collector", async () => {
  const base = mkdtempSync(join(tmpdir(), "fixture-cap-dead-collector-"));
  try {
    const locks = join(base, ".local", "state", "jig", "gc-locks", "scratch");
    mkdirSync(locks, { recursive: true });
    const writer = join(locks, "writer");
    const holder = encodeIdentity({ ...ownIdentity(), pid: 2_147_483_647 });
    writeFileSync(writer, holder);
    const scopeModule = import.meta.resolve("../../../lib/test-tmpdir.ts");
    const child = await fixtureChildResult(
      fixtureChild(
        `
      delete process.env.JIG_TEST_FIXTURE_REGISTRY;
      delete process.env.JIG_TEST_FIXTURE_NODE;
      const { scopeTestTmpdir } = await import(${JSON.stringify(scopeModule)});
      const scope = scopeTestTmpdir({ fixtureStartup: true });
      console.log("working");
      scope.release();
    `,
        base,
      ),
    );
    expectSpawnExit(child, 0);
    expect(child.stdout.trim()).toBe("working");
    expect(child.stderr).toContain("the scope remains report-only");
    expect(readFileSync(writer, "utf8")).toBe(holder);
    expect(existsSync(testFixtureRegistryRoot(base))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 15_000);
