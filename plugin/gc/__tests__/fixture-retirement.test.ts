import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { encodeIdentity, ownIdentity } from "../../shared/liveness.ts";
import { writeScratchOwner } from "../../shared/scratch-owner.ts";
import {
  cachedFixtureEnclosure,
  withoutRetired,
  nextFixtureRegistryPage,
  registerFixtureScope,
} from "../../shared/test-fixture-registry.ts";
import { fixtureRetirement } from "../kinds/fixture-retirement.ts";
import { scratchKind } from "../kinds/scratch.ts";
import { runCollection } from "../runner.ts";
import type { ReceiptLine } from "../types.ts";

const registration = resolve(
  import.meta.dir,
  "../../shared/test-fixture-registry.ts",
);
const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true });
});
type Registered = { root: string; launch?: "opaque" | "pending" };
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "gc-retire-"));
  bases.push(base);
  return { base, store: join(base, "registrations") };
}
/** Register each scope in its own registry from a process that has exited by the time gc looks. */
function registerExited(store: string, scopes: Registered[]): void {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    const { registerFixtureScope, beginFixtureLaunch } = await import(${JSON.stringify(registration)});
    for (const { root, launch } of ${JSON.stringify(scopes)}) {
      const registered = registerFixtureScope(root, undefined, ${JSON.stringify(store)});
      if (!registered.ok) throw new Error(registered.failure.reason);
      if (launch) {
        const edge = beginFixtureLaunch(registered.value, launch === "pending");
        if (!edge.ok) throw new Error(edge.failure.reason);
      }
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
function run(
  f: ReturnType<typeof fixture>,
  collect: boolean,
  bounds: { pageSize?: number; batchSize?: number } = {},
) {
  const kind = scratchKind(
    f.base,
    [join(f.base, "scope-")],
    "fixture declaration",
    0,
    f.store,
    bounds,
  );
  return runCollection([kind], {
    collect,
    receiptRoot: join(f.base, "receipts"),
  });
}
function retiredIn(lines: ReceiptLine[]): string[] {
  return lines.flatMap((line) => {
    const details = line.details as { retired?: string[] } | undefined;
    return line.outcome === "collected" ? (details?.retired ?? []) : [];
  });
}
function batchLines(lines: ReceiptLine[]): ReceiptLine[] {
  return lines.filter((line) =>
    line.resource.startsWith("fixture-registrations:"),
  );
}

test("a store larger than one run's bound is retired over successive runs", async () => {
  const f = fixture();
  registerExited(f.store, [
    { root: join(f.base, "kept-0"), launch: "pending" },
    { root: join(f.base, "kept-1"), launch: "pending" },
  ]);
  // Kept registrations sort first, so only a resumed page reaches the rest.
  readdirSync(f.store).forEach((name, i) => {
    renameSync(
      join(f.store, name),
      join(f.store, `00000000-0000-4000-8000-00000000000${i}`),
    );
  });
  const kept = readdirSync(f.store).toSorted();
  registerExited(
    f.store,
    Array.from({ length: 3 }, (_, i) => ({ root: join(f.base, `gone-${i}`) })),
  );
  const retirable = readdirSync(f.store)
    .filter((name) => !kept.includes(name))
    .toSorted();
  const retired: string[] = [];
  for (let runs = 0; runs < 3; runs++) {
    const { receipt } = await run(f, true, { pageSize: 2, batchSize: 1 });
    expect(receipt.exitStatus).toBe(0);
    expect(
      receipt.resources.filter((line) => line.reason.includes("bounded scan")),
    ).toEqual([]);
    expect(batchLines(receipt.resources)).toHaveLength(2);
    retired.push(...retiredIn(receipt.resources));
  }
  expect(retired.toSorted()).toEqual(retirable);
  expect(readdirSync(f.store).toSorted()).toEqual(kept);
});

test("a report run reads the next page without moving past it", async () => {
  const f = fixture();
  registerExited(
    f.store,
    Array.from({ length: 3 }, (_, i) => ({ root: join(f.base, `gone-${i}`) })),
  );
  const first = readdirSync(f.store).toSorted()[0];
  const report = scratchKind(
    f.base,
    [join(f.base, "scope-")],
    "fixture declaration",
    0,
    f.store,
    { pageSize: 1, advance: false },
  );
  for (let runs = 0; runs < 2; runs++) {
    const { receipt } = await runCollection([report], {
      collect: false,
      receiptRoot: join(f.base, "receipts"),
    });
    expect(batchLines(receipt.resources)).toMatchObject([
      { resource: expect.stringContaining(`:${first}..`) },
    ]);
  }
  expect(existsSync(`${f.store}.cursor`)).toBe(false);
});

test("a report names what would be retired and keeps it", async () => {
  const f = fixture();
  registerExited(f.store, [{ root: join(f.base, "gone") }]);
  const { receipt } = await run(f, false);
  expect(batchLines(receipt.resources)).toMatchObject([
    { outcome: "would-collect", details: { registrations: 1 } },
  ]);
  expect(readdirSync(f.store)).toHaveLength(1);
});

test("a registration whose root exists is not retired", async () => {
  const f = fixture();
  // Outside the declared prefix, so the scratch proof never removes it.
  const root = join(f.base, "present");
  mkdirSync(root);
  registerExited(f.store, [{ root }, { root: join(f.base, "gone") }]);
  const { receipt } = await run(f, true);
  expect(retiredIn(receipt.resources)).toHaveLength(1);
  expect(readdirSync(f.store)).toHaveLength(1);
});

test("a registration whose registered process still runs is kept", async () => {
  const f = fixture();
  const registered = registerFixtureScope(
    join(f.base, "gone-live"),
    undefined,
    f.store,
  );
  if (!registered.ok) throw new Error(registered.failure.reason);
  const { receipt } = await run(f, true);
  expect(batchLines(receipt.resources)).toMatchObject([
    {
      outcome: "refused",
      details: {
        kept: [
          { state: "live", reason: "a registered fixture process still runs" },
        ],
      },
    },
  ]);
  expect(existsSync(registered.value.registry)).toBe(true);
});

test("an unacknowledged launch keeps its registration", async () => {
  const f = fixture();
  registerExited(f.store, [
    { root: join(f.base, "gone-pending"), launch: "pending" },
  ]);
  const { receipt } = await run(f, true);
  expect(batchLines(receipt.resources)).toMatchObject([
    {
      outcome: "unverified",
      details: {
        kept: [{ reason: "fixture launch has no child acknowledgement" }],
      },
    },
  ]);
  expect(readdirSync(f.store)).toHaveLength(1);
});

test("an opaque launch keeps its registration only while a scratch scope encloses its root", async () => {
  const f = fixture();
  const enclosing = join(f.base, "enclosing");
  mkdirSync(enclosing);
  writeScratchOwner(enclosing);
  // No ancestor of an absent top-level path holds a scratch owner record.
  const unenclosed = join("/", `jig-gc-retire-absent-${crypto.randomUUID()}`);
  registerExited(f.store, [
    { root: join(enclosing, "gone-opaque"), launch: "opaque" },
    { root: join(unenclosed, "gone-opaque"), launch: "opaque" },
  ]);
  const { receipt } = await run(f, true);
  expect(retiredIn(receipt.resources)).toHaveLength(1);
  expect(batchLines(receipt.resources)[0]?.details).toMatchObject({
    kept: [
      {
        reason: expect.stringContaining("an enclosing scratch scope"),
      },
    ],
  });
  expect(readdirSync(f.store)).toHaveLength(1);
});

test("an opaque launch keeps its registration while another registration's root encloses its root", async () => {
  const f = fixture();
  const outer = join(f.base, "outer");
  registerExited(f.store, [
    { root: outer },
    { root: join(outer, "gone-opaque"), launch: "opaque" },
  ]);
  const { receipt } = await run(f, true);
  expect(retiredIn(receipt.resources)).toHaveLength(1);
  expect(batchLines(receipt.resources)[0]?.details).toMatchObject({
    kept: [{ reason: expect.stringContaining("registered root") }],
  });
  expect(readdirSync(f.store)).toHaveLength(1);
});

test("an opaque launch keeps its registration while another registration holds the same root", async () => {
  const f = fixture();
  // No ancestor of an absent top-level path holds a scratch owner record.
  const shared = join("/", `jig-gc-retire-absent-${crypto.randomUUID()}`);
  registerExited(f.store, [
    { root: shared, launch: "opaque" },
    { root: shared },
  ]);
  const { receipt } = await run(f, true);
  // The plain registration holds the root for its sibling; the opaque one is kept.
  expect(retiredIn(receipt.resources)).toHaveLength(1);
  expect(readdirSync(f.store)).toHaveLength(1);
});

test("a registration whose scope was written by a running unrecorded process is kept", async () => {
  const f = fixture();
  registerExited(f.store, [{ root: join(f.base, "gone-a") }]);
  const [name] = readdirSync(f.store);
  const registry = join(f.store, name ?? "");
  const scopeFile = readdirSync(registry).find((entry) => entry !== "nodes");
  const path = join(registry, scopeFile ?? "");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.registeredBy = encodeIdentity(ownIdentity());
  writeFileSync(path, JSON.stringify(record));
  const { receipt } = await run(f, true);
  expect(retiredIn(receipt.resources)).toEqual([]);
  expect(readdirSync(f.store)).toEqual([name ?? ""]);
});

test("opaque registrations spread over several batches are all retired", async () => {
  const f = fixture();
  registerExited(
    f.store,
    Array.from({ length: 3 }, (_, i) => ({
      root: join("/", `jig-gc-retire-absent-${crypto.randomUUID()}-${i}`),
      launch: "opaque" as const,
    })),
  );
  const { receipt } = await run(f, true, { batchSize: 1 });
  expect(retiredIn(receipt.resources)).toHaveLength(3);
  expect(readdirSync(f.store)).toEqual([]);
});

test("a malformed folder is reported as itself and the rest are retired", async () => {
  const f = fixture();
  registerExited(f.store, [
    { root: join(f.base, "gone-a") },
    { root: join(f.base, "gone-b") },
  ]);
  const stray = join(f.store, "stray");
  writeFileSync(stray, "");
  const { receipt } = await run(f, true);
  expect(
    receipt.resources.find((line) => line.resource.endsWith(stray)),
  ).toMatchObject({
    outcome: "unverified",
    reason: "malformed registration: not a registration folder",
  });
  expect(retiredIn(receipt.resources)).toHaveLength(2);
  expect(readdirSync(f.store)).toEqual(["stray"]);
});

test("a scope added to a live registration between two batches' proofs still encloses the later batch", async () => {
  const f = fixture();
  const absent = join("/", `jig-gc-retire-absent-${crypto.randomUUID()}`);
  const nested = (name: string) => join(absent, name);
  registerExited(f.store, [
    { root: nested("a"), launch: "opaque" },
    { root: nested("b"), launch: "opaque" },
    { root: join(f.base, "live-root") },
  ]);
  mkdirSync(join(f.base, "live-root"));
  const page = nextFixtureRegistryPage(f.store);
  if (!page.ok) throw new Error(page.failure.reason);
  const retirement = fixtureRetirement(f.store, 1);
  const { resources } = retirement.list(page.value);
  expect(resources).toHaveLength(2);
  const first = resources[0];
  const second = resources[1];
  if (!first || !second) throw new Error("expected two batches");
  expect((await retirement.prove(first)).state).toBe("dead");
  retirement.collect(first);
  // An existing registration gains a scope without touching the store directory.
  const live = page.value.registrations.find((entry) =>
    entry.scopes.some((scope) => scope.root === join(f.base, "live-root")),
  );
  if (!live) throw new Error("expected the live registration");
  const added = registerFixtureScope(
    absent,
    {
      registry: live.registry,
      node: readdirSync(join(live.registry, "nodes"))[0] ?? "",
    },
    f.store,
  );
  expect(added.ok).toBe(true);
  expect((await retirement.prove(second)).state).toBe("unverified");
});

test("the enclosure index is reused across batches only while the store is unchanged", () => {
  const f = fixture();
  registerExited(f.store, [{ root: join(f.base, "a") }]);
  const age = (path: string) =>
    utimesSync(
      path,
      new Date(Date.now() - 3_600_000),
      new Date(Date.now() - 3_600_000),
    );
  for (const name of readdirSync(f.store)) age(join(f.store, name));
  const first = cachedFixtureEnclosure(f.store);
  expect(cachedFixtureEnclosure(f.store, first)).toBe(first);
  const registry = join(f.store, readdirSync(f.store)[0] ?? "");
  const node = readdirSync(join(registry, "nodes"))[0] ?? "";
  expect(
    registerFixtureScope(join(f.base, "b"), { registry, node }, f.store).ok,
  ).toBe(true);
  expect(cachedFixtureEnclosure(f.store, first)).not.toBe(first);
});

test("the cached enclosure index survives the collector's own retirements", () => {
  const f = fixture();
  registerExited(f.store, [{ root: join(f.base, "a") }]);
  registerExited(f.store, [{ root: join(f.base, "c") }]);
  const old = new Date(Date.now() - 3_600_000);
  for (const name of readdirSync(f.store))
    utimesSync(join(f.store, name), old, old);
  const first = cachedFixtureEnclosure(f.store);
  const [gone] = readdirSync(f.store);
  rmSync(join(f.store, gone ?? ""), { recursive: true, force: true });
  const next = withoutRetired(first, [join(f.store, gone ?? "")]);
  expect(cachedFixtureEnclosure(f.store, next)).toBe(next);
  expect(next.index.roots.size).toBe(1);
  expect(next.index.held.has(join(f.store, gone ?? ""))).toBe(false);
  expect(next.index.held.size).toBe(1);
});
