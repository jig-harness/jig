/** Observed dashboard evidence survives a defect in any later repository phase. */
import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import type { TickReceipt } from "../receipts.ts";
import { SLUG, type World, world } from "./fixtures.ts";
import { earlierRecord, machineFile } from "./launch-fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

for (const [phase, module, name] of [
  ["plan", "tick-plan", "planObserved"],
  ["log", "tick-settle", "logRepo"],
  ["labels", "tick-labels", "projectObserved"],
] as const) {
  it(`keeps observed stuck sessions when ${phase} throws`, async () => {
    const w = world();
    current = w;
    w.setConfig("dispatch: {}\n");
    machineFile(w, [], {}, ["notify"]);
    const record = earlierRecord(w, {
      id: "20261030T200000Z-aaaaaaaa",
      account: "a",
      repo: SLUG,
      attempts: [
        { at: "2026-10-30T20:00:00.000Z", outcome: "sent", detail: "started" },
      ],
    });
    const entry = join(w.root, "phase-defect.ts");
    writeFileSync(
      entry,
      `import { mock } from "bun:test";
const path = ${JSON.stringify(`${DISPATCH}/lib/${module}.ts`)};
const real = await import(path);
const original = real.${name};
mock.module(path, () => ({ ...real, ${name}: async (...args) => {
  await original(...args);
  throw new Error("phase failed");
} }));
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const { readLine } = await import(${JSON.stringify(`${DISPATCH}/lib/line-store.ts`)});
const { readMachineConfig } = await import(${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)});
const read = readMachineConfig();
if (!read.ok) throw new Error(read.failure.reason);
const machine = read.value;
if (machine === null) throw new Error("no machine file");
const result = await runTick({ repos: process.argv.slice(2), machine });
if ("held" in result) process.exit(3);
console.log(JSON.stringify({ receipt: result.receipt, line: readLine() }));
process.exit(result.receipt.exitStatus);
`,
    );
    const r = await w.dispatch([w.repo], entry);
    expectSpawnExit(r, 1);
    const result = JSON.parse(r.stdout) as {
      receipt: TickReceipt;
      line: { ok: true; value: LineSnapshot };
    };
    expect(result.receipt.repos[0]?.defect?.phase).toBe(phase);
    expect(result.receipt.repos[0]?.defect?.reason).toContain("phase failed");
    expect(result.line.ok).toBe(true);
    const session = result.line.value.sessions.find(
      (s) => s.record === record.id,
    );
    expect(session?.stuck).toContain(
      "no wrapper claimed it within unclaimed_after",
    );
    expect(
      result.line.value.needs.find((n) => n.stuckRecord === record.id),
    ).toBeDefined();
  });
}
