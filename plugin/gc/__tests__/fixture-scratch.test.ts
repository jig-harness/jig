import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import {
  identityOf,
  reapOwnedIdentities,
} from "../../../lib/test-reap-children.ts";
import { writeScratchOwner } from "../../shared/scratch-owner.ts";
import { scratchKind } from "../kinds/scratch.ts";
import { runCollection } from "../runner.ts";

const registration = resolve(
  import.meta.dir,
  "../../shared/test-fixture-registry.ts",
);
function setup(opaque = false, outside = false) {
  const base = mkdtempSync(join(tmpdir(), "gc-fixture-"));
  const root = join(base, "scope-dead");
  const store = join(base, "registrations");
  const outsideRoot = join(base, "outside");
  mkdirSync(root);
  if (outside) mkdirSync(outsideRoot);
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    const { registerFixtureScope, beginFixtureLaunch } = await import(${JSON.stringify(registration)});
    const registered = registerFixtureScope(${JSON.stringify(root)}, undefined, ${JSON.stringify(store)});
    if (!registered.ok) throw new Error(registered.failure.reason);
    if (${outside}) {
      const sibling = registerFixtureScope(${JSON.stringify(outsideRoot)}, registered.value, ${JSON.stringify(store)});
      if (!sibling.ok) throw new Error(sibling.failure.reason);
    }
    if (${opaque}) {
      const launch = beginFixtureLaunch(registered.value, false);
      if (!launch.ok) throw new Error(launch.failure.reason);
    }
  `,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
      timeout: 30_000,
    },
  );
  expectSpawnExit(child, 0);
  return { base, root, store, outsideRoot };
}
async function collect(
  f: ReturnType<typeof setup>,
  enabled: boolean,
  idleDays = 0,
) {
  const kind = scratchKind(
    f.base,
    [join(f.base, "scope-")],
    "fixture declaration",
    idleDays,
    f.store,
  );
  return runCollection([kind], {
    collect: enabled,
    receiptRoot: join(f.base, "receipts"),
  });
}

test.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "Bun on Windows ends the grandchild when its runner exits",
  ),
)(
  "report preserves a registered orphan, then collection reaps it before removing scratch",
  async () => {
    const f = setup();
    // Replace the helper's childless registration with this runner's tree.
    rmSync(f.store, { recursive: true });
    const ready = join(f.base, "orphan-ready.json");
    let identity: Awaited<ReturnType<typeof identityOf>> = null;
    try {
      const runner = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
      const { registerFixtureScope, beginFixtureLaunch } = await import(${JSON.stringify(registration)});
      const scope = registerFixtureScope(${JSON.stringify(f.root)}, undefined, ${JSON.stringify(f.store)});
      if (!scope.ok) throw new Error(scope.failure.reason);
      const launch = beginFixtureLaunch(scope.value, true);
      if (!launch.ok) throw new Error(launch.failure.reason);
      const source =
        "const { acknowledgeFixtureLaunch } = await import(" + ${JSON.stringify(JSON.stringify(registration))} + ");" +
        "const acknowledged = acknowledgeFixtureLaunch(" + JSON.stringify(launch.value) + ");" +
        "if (!acknowledged.ok) throw new Error(acknowledged.failure.reason);" +
        "await Bun.write(" + ${JSON.stringify(JSON.stringify(ready))} + ", JSON.stringify({ pid: process.pid }));" +
        "setInterval(() => {}, 1000);";
      const child = Bun.spawn([process.execPath, "-e", source], {
        stdout: "ignore", stderr: "ignore", env: { ...process.env },
      });
      const deadline = Date.now() + 10000;
      while (!(await Bun.file(${JSON.stringify(ready)}).exists())) {
        if (Date.now() >= deadline) {
          child.kill();
          throw new Error("fixture child did not acknowledge its registration");
        }
        await Bun.sleep(20);
      }
      process.exit(0);
    `,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
          timeout: 20_000,
        },
      );
      expectSpawnExit(runner, 0);
      const { pid } = JSON.parse(readFileSync(ready, "utf8")) as {
        pid: number;
      };
      identity = await identityOf(pid);
      expect(identity).not.toBeNull();

      const report = await collect(f, false);
      expect(
        report.receipt.resources.find((line) => line.resource === f.root)
          ?.outcome,
      ).toBe("refused");
      expect(await identityOf(pid)).toEqual(identity);
      expect(existsSync(f.root)).toBe(true);

      const result = await collect(f, true);
      expect(result.receipt.exitStatus).toBe(0);
      expect(
        result.receipt.resources.find((line) => line.resource === f.root)
          ?.outcome,
      ).toBe("collected");
      expect(existsSync(f.root)).toBe(false);
      const deadline = Date.now() + 5000;
      while ((await identityOf(pid)) !== null && Date.now() < deadline)
        await Bun.sleep(20);
      expect(await identityOf(pid)).toBeNull();
    } finally {
      if (!identity && existsSync(ready)) {
        const { pid } = JSON.parse(readFileSync(ready, "utf8")) as {
          pid: number;
        };
        identity = await identityOf(pid);
      }
      if (identity) await reapOwnedIdentities([identity]);
      rmSync(f.base, { recursive: true, force: true });
    }
  },
  45_000,
);

test("reports a dead registered scope, then collects a recreated root without an owner file", async () => {
  const f = setup();
  rmSync(f.root, { recursive: true });
  mkdirSync(f.root);
  const report = await collect(f, false);
  expect(
    report.receipt.resources.find((line) => line.resource === f.root)?.outcome,
  ).toBe("would-collect");
  expect(existsSync(f.root)).toBe(true);
  const result = await collect(f, true);
  expect(result.receipt.exitStatus).toBe(0);
  expect(
    result.receipt.resources.find((line) => line.resource === f.root)?.outcome,
  ).toBe("collected");
  expect(existsSync(f.root)).toBe(false);
});

test("a nested legacy owner vetoes collection of a recreated registered root", async () => {
  const f = setup();
  rmSync(f.root, { recursive: true });
  mkdirSync(join(f.root, "nested"), { recursive: true });
  writeScratchOwner(join(f.root, "nested"));
  const result = await collect(f, true);
  expect(
    result.receipt.resources.find((line) => line.resource === f.root),
  ).toMatchObject({
    outcome: "refused",
    reason: "a scope owner in the subtree is alive",
  });
  expect(existsSync(f.root)).toBe(true);
});

test("native launch uncertainty retains scratch after its parent exits", async () => {
  const f = setup(true);
  const result = await collect(f, true);
  expect(
    result.receipt.resources.find((line) => line.resource === f.root),
  ).toMatchObject({
    outcome: "unverified",
    reason: expect.stringContaining("opaque native"),
  });
  expect(existsSync(f.root)).toBe(true);
});

test("registered roots still obey the idle guard", async () => {
  const f = setup();
  const result = await collect(f, true, 7);
  expect(
    result.receipt.resources.find((line) => line.resource === f.root)?.outcome,
  ).toBe("refused");
  expect(existsSync(f.root)).toBe(true);
});

test("a fixture graph outside declared bounds vetoes process cleanup without widening directory removal", async () => {
  const f = setup(false, true);
  const result = await collect(f, true);
  expect(
    result.receipt.resources.find((line) =>
      line.resource.startsWith("fixture-processes:"),
    ),
  ).toMatchObject({
    outcome: "unverified",
    reason:
      "fixture membership includes scopes outside declared scratch prefixes",
  });
  expect(
    result.receipt.resources.find((line) => line.resource === f.root)?.outcome,
  ).toBe("collected");
  expect(existsSync(f.outsideRoot)).toBe(true);
});

test("a nested registration added after inventory vetoes the final proof", async () => {
  const f = setup();
  const kind = scratchKind(
    f.base,
    [join(f.base, "scope-")],
    "fixture declaration",
    0,
    f.store,
  );
  const listed = await kind.inventory();
  if (!listed.ok) throw new Error(listed.failure.reason);
  const resource = listed.value.find((entry) => entry.id === f.root);
  if (!resource) throw new Error("registered root absent");
  expect((await kind.prove(resource)).state).toBe("dead");
  const nested = join(f.root, "nested");
  mkdirSync(nested);
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    const { registerFixtureScope, beginFixtureLaunch } = await import(${JSON.stringify(registration)});
    const registered = registerFixtureScope(${JSON.stringify(nested)}, undefined, ${JSON.stringify(f.store)});
    if (!registered.ok) throw new Error(registered.failure.reason);
    const launch = beginFixtureLaunch(registered.value, false);
    if (!launch.ok) throw new Error(launch.failure.reason);
  `,
    ],
    {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(child, 0);
  expect(await kind.prove(resource)).toMatchObject({
    state: "unverified",
    reason: expect.stringContaining("opaque native"),
  });
  expect(existsSync(f.root)).toBe(true);
});

test.skipIf(
  skipsOnWindows(
    "file-system",
    "symlink creation requires a privilege not held by Windows CI",
  ),
)(
  "a registered root replaced by a symlink never deletes its target",
  async () => {
    const f = setup();
    const target = join(f.base, "target");
    mkdirSync(target);
    rmSync(f.root, { recursive: true });
    symlinkSync(target, f.root, "dir");
    const result = await collect(f, true);
    expect(
      result.receipt.resources.find((line) => line.resource === f.root)
        ?.outcome,
    ).toBe("finding");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(f.root)).toBe(true);
  },
);
