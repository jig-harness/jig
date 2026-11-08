/**
 * dispatch --apply: each stage of a repository's turn is its own defect
 * boundary. A defect thrown in the re-arm stage, the first launch stage of
 * the tick's first turn, stops that stage only: the pickup the same tick
 * launches after it still starts, the receipt and the outcome log carry the
 * defect's code, stage and reason, and its stack goes to the tick's error
 * output. The tick runs in a child with its own home (fixtures.ts), from a
 * script that makes the re-arm stage throw.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRows } from "../lib/log.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");

/**
 * A tick with `--apply` and an Orca runtime that binds interactive
 * sessions (`pickup-fixtures.ts`), whose re-arm stage throws a bug.
 */
const REARM_DEFECT = `import { mock } from "bun:test";
const drive = ${JSON.stringify(`${DISPATCH}/lib/actions/drive.ts`)};
const real = await import(drive);
mock.module(drive, () => ({ ...real, applyDrives: async () => { throw new TypeError("a bug in the re-arm stage"); } }));
const { readMachineConfig } = await import(${JSON.stringify(`${DISPATCH}/lib/machine-config.ts`)});
const { orcaRuntime } = await import(${JSON.stringify(`${DISPATCH}/lib/runtime/orca.ts`)});
const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const read = readMachineConfig();
if (!read.ok || read.value === null) throw new Error("the tick needs a machine file");
const machine = read.value;
const result = await runTick({
  repos: machine.repositories.map((r) => r.path),
  apply: true,
  machine,
  runtime: orcaRuntime(
    { runtimeTimeoutMs: machine.runtimeTimeoutMs, workspaceTimeoutMs: machine.workspaceTimeoutMs },
    { ok: true },
  ),
});
if ("held" in result) process.exit(3);
console.log(JSON.stringify(result.receipt));
process.exit(result.receipt.exitStatus);
`;

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

describe("a defect in one stage of a repository's --apply", () => {
  it("stops that stage only: the tick's other launches start, and the receipt and the outcome log carry the defect", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "pickup"]);
    const entry = join(w.root, "rearm-defect.ts");
    writeFileSync(entry, REARM_DEFECT);
    const r = await w.dispatch([], entry);
    // A defect fails the tick, as one that stops a turn does.
    expectSpawnExit(r, 1);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    const [report] = receipt.repos;
    const reason =
      "a TypeError was thrown in the rearm stage of the apply phase: a bug in the re-arm stage";

    // The re-arm stage leads the tick's first turn; the pickup after it still launched.
    expect(report?.launches).toEqual([
      expect.objectContaining({
        action: "pickup",
        target: "#12",
        outcome: "launched",
      }),
    ]);
    expect(report?.stageDefects).toEqual([
      { code: "defect", phase: "apply", stage: "rearm", reason },
    ]);
    // The turn itself was not stopped.
    expect(report?.refused).toBeNull();
    expect(report?.defect).toBeUndefined();
    expect(receipt.completed).toBe(true);

    const rows = readRows(
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      dispatchState(w),
    ).filter((row) => row.kind === "event" && row.event === "defect");
    expect(rows).toEqual([
      expect.objectContaining({
        repo: SLUG,
        stage: "rearm",
        class: null,
        reason,
      }),
    ]);

    // The stack goes to the error output, never on the receipt or in the log.
    expect(r.stderr).toContain(
      `a defect stopped the rearm stage of ${SLUG}'s turn: ${reason}\nTypeError: a bug in the re-arm stage\n    at `,
    );
    expect(r.stdout).not.toContain("    at ");
    expect(JSON.stringify(rows)).not.toContain("    at ");

    const text = await w.dispatch(["receipts"]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain("1 defect(s)");
  });
});
