import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { encodeIdentity, ownIdentity } from "../../shared/liveness.ts";
import { currentIso } from "../../shared/time.ts";

const INITIAL = 220_000;
const BOUND = 200_000;
const PAGE_SIZE = (INITIAL - BOUND) / 2;
const RUN_DEADLINE_MS = 25_000;

/** Standalone v1 folders model a legacy store with no sidecar or cursor. */
function populate(base: string, store: string): void {
  mkdirSync(store);
  const root = join(base, "removed");
  const scope = `scope-${createHash("sha256").update(root).digest("hex")}.json`;
  const identity = encodeIdentity({ ...ownIdentity(), pid: 2_147_483_647 });
  const node = `${randomUUID()}.json`;
  const createdAt = currentIso();
  const scopeRecord = JSON.stringify({
    version: 1,
    root,
    createdAt,
    registeredBy: identity,
  });
  const nodeRecord = JSON.stringify({
    version: 1,
    state: "registered",
    parent: null,
    identity,
  });
  for (let i = 0; i < INITIAL; i++) {
    // The order of names does not follow insertion order. Replicate the
    // files across hard-link families to stay under filesystem link limits.
    const registry = join(
      store,
      String((i * 65537) % INITIAL).padStart(6, "0"),
    );
    const nodes = join(registry, "nodes");
    mkdirSync(registry);
    mkdirSync(nodes);
    const family = Math.floor(i / 10_000);
    const scopeSource = join(base, `scope-${family}`);
    const nodeSource = join(base, `node-${family}`);
    if (i % 10_000 === 0) {
      writeFileSync(scopeSource, scopeRecord);
      writeFileSync(nodeSource, nodeRecord);
    }
    linkSync(scopeSource, join(registry, scope));
    linkSync(nodeSource, join(nodes, node));
  }
}

test("successive collections drain a large legacy registry in bounded pages", async () => {
  const base = mkdtempSync(join(tmpdir(), "gc-retire-scale-"));
  try {
    const store = join(base, "registrations");
    populate(base, store);
    const child = await runScale(base, store);
    expectSpawnExit(child, 0);
    const runs = JSON.parse(child.stdout);
    expect(runs).toEqual([
      {
        exitStatus: 0,
        collected: true,
        count: INITIAL - PAGE_SIZE,
        limit: BOUND,
        elapsed: expect.any(Number),
      },
      {
        exitStatus: 0,
        collected: true,
        count: BOUND,
        limit: BOUND,
        elapsed: expect.any(Number),
      },
    ]);
    for (const run of runs) expect(run.elapsed).toBeLessThan(RUN_DEADLINE_MS);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 90_000);

async function runScale(base: string, store: string) {
  const index = import.meta.resolve("../../shared/fixture-registry-index.ts");
  const scratch = import.meta.resolve("../kinds/scratch.ts");
  const runner = import.meta.resolve("../runner.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
      import { fixtureRegistryUsage } from ${JSON.stringify(index)};
      import { scratchKind } from ${JSON.stringify(scratch)};
      import { runCollection } from ${JSON.stringify(runner)};
      import { join } from "node:path";
      const base = ${JSON.stringify(base)};
      const store = ${JSON.stringify(store)};
      const receiptRoot = join(base, "receipts");
      const runs = [];
      for (let i = 0; i < 2; i++) {
        const kind = scratchKind(base, [join(base, "scratch-")], "fixture declaration", 0, store, {pageSize: ${PAGE_SIZE}});
        const start = performance.now();
        const {receipt} = await runCollection([kind], {collect: true, receiptRoot});
        const usage = fixtureRegistryUsage(store);
        if (!usage.ok) throw Error(usage.failure.reason);
        runs.push({
          exitStatus: receipt.exitStatus,
          collected: receipt.resources.every((line) => line.outcome === "collected"),
          ...usage.value,
          elapsed: performance.now() - start,
        });
      }
      console.log(JSON.stringify(runs));
    `,
    ],
    {
      env: { ...process.env, JIG_TEST_FIXTURE_REGISTRY_LIMIT: String(BOUND) },
      stdout: "pipe",
      stderr: "pipe",
      timeout: RUN_DEADLINE_MS * 2 + 5000,
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout.text(),
    child.stderr.text(),
  ]);
  return { exitCode, stdout, stderr };
}
