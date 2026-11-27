import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { fixtureRegistryUsage } from "../../shared/fixture-registry-index.ts";
import { scratchKind } from "../kinds/scratch.ts";
import { runCollection } from "../runner.ts";

const registration = resolve(
  import.meta.dir,
  "../../shared/test-fixture-registry.ts",
);
const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true });
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "gc-killed-"));
  bases.push(base);
  return { base, store: join(base, "registrations") };
}
/** Register one scope per root from a process that has exited by the time gc looks. */
function registerExited(store: string, roots: string[]): void {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    const { registerFixtureScope } = await import(${JSON.stringify(registration)});
    for (const root of ${JSON.stringify(roots)}) {
      const registered = registerFixtureScope(root, undefined, ${JSON.stringify(store)});
      if (!registered.ok) throw new Error(registered.failure.reason);
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
}
function collect(f: ReturnType<typeof fixture>) {
  const kind = scratchKind(
    f.base,
    [join(f.base, "scope-")],
    "fixture declaration",
    0,
    f.store,
    {},
  );
  return runCollection([kind], {
    collect: true,
    receiptRoot: join(f.base, "receipts"),
  });
}

test("a registration whose scope file a killed collector removed first is retired by the next run", async () => {
  const f = fixture();
  registerExited(f.store, [join(f.base, "gone")]);
  const [registry] = readdirSync(f.store);
  for (const name of readdirSync(join(f.store, registry as string)))
    if (name.startsWith("scope-"))
      rmSync(join(f.store, registry as string, name));
  const { receipt } = await collect(f);
  expect(receipt.exitStatus).toBe(0);
  expect(readdirSync(f.store)).toEqual([]);
});

test("a registration folder removed before the index heard of it is not counted", () => {
  const f = fixture();
  registerExited(f.store, [join(f.base, "a"), join(f.base, "b")]);
  expect(fixtureRegistryUsage(f.store)).toMatchObject({
    ok: true,
    value: { count: 2 },
  });
  // A collector killed between deleting a folder and updating the index.
  rmSync(join(f.store, readdirSync(f.store)[0] as string), { recursive: true });
  expect(fixtureRegistryUsage(f.store)).toMatchObject({
    ok: true,
    value: { count: 1 },
  });
});
