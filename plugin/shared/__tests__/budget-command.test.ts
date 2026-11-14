import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { recordCall } from "../outbound/ledger.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const jig = resolve(import.meta.dir, "../../jig.ts");
const ledger = resolve(import.meta.dir, "../outbound/ledger.ts");

test("jig budget groups operations and callers across hours, retaining unknown costs and units", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-budget-command-"));
  roots.push(root);
  const path = join(root, "budget.sqlite");
  const at = Date.now();
  const call = {
    path,
    system: "linear",
    credential: "linear:test",
    operation: "Queue",
    caller: "tick:one",
    unit: "points",
    durationMs: 10,
  };
  recordCall({ ...call, at: at - 3_600_000, cost: 100 });
  recordCall({ ...call, at, cost: 200 });
  recordCall({ ...call, at, caller: "skill:pickup", cost: null });
  const script = `import {main} from ${JSON.stringify(jig)}; import {withLedgerPath} from ${JSON.stringify(ledger)}; process.exit(await withLedgerPath(${JSON.stringify(path)},()=>main(["budget","--hours","2","--json"])));`;
  const result = Bun.spawnSync([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 0);
  const answer = JSON.parse(result.stdout.toString());
  expect(answer.operations).toHaveLength(1);
  expect(answer.operations[0]).toMatchObject({
    operation: "Queue",
    requests: 3,
    cost: 300,
    unknownCost: 1,
    unit: "points",
    durationMs: 30,
  });
  expect(answer.callers).toHaveLength(2);
  expect(
    answer.callers.find((c: { caller: string }) => c.caller === "tick:one"),
  ).toMatchObject({ cost: 300, requests: 2 });
});

test("jig budget refuses a window beyond retained history", () => {
  const result = Bun.spawnSync(
    [process.execPath, jig, "budget", "--hours", "169"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain("integer from 1 to 168");
});
