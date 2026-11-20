/**
 * A tick's receipt says what started it: the timer (whose launcher passes
 * its scheduled upgrade), Jig's wake waiter, the `jig` command run directly,
 * or another launcher that names itself.
 */
import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TickReceipt } from "../receipts.ts";
import { type World, world } from "./fixtures.ts";

const DISPATCH = resolve(import.meta.dir, "..");
let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function entry(w: World): string {
  const path = join(w.root, "starter-tick.ts");
  writeFileSync(
    path,
    `const { runTick } = await import(${JSON.stringify(`${DISPATCH}/tick.ts`)});
const result = await runTick({ repos: [process.cwd()] });
if ("held" in result) throw new Error("fixture tick lock held");
console.log(JSON.stringify({ receipt: result.receipt, starter: process.env.JIG_STARTED_BY ?? null }));
`,
  );
  return path;
}

it("records the timer, the wake waiter, the jig command and another launcher as what started the tick", async () => {
  const w = world();
  current = w;
  const script = entry(w);
  const started = async (env: Record<string, string>) => {
    const r = await w.dispatch([], script, env);
    expect(r.stdout, r.stderr).not.toBe("");
    return JSON.parse(r.stdout) as {
      receipt: TickReceipt;
      starter: string | null;
    };
  };
  const timer = await started({
    JIG_SCHEDULED_UPGRADE: JSON.stringify({
      outcome: "withheld",
      detail: "the interval's attempt was already made",
      at: "2026-11-20T12:00:00.000Z",
    }),
  });
  expect(timer.receipt.startedBy).toBe("timer");
  const woken = await started({ JIG_STARTED_BY: "wake" });
  expect(woken.receipt.startedBy).toBe("wake");
  const command = await started({ JIG_STARTED_BY: "command" });
  expect(command.receipt.startedBy).toBe("command");
  const plugin = await started({ JIG_STARTED_BY: "orca-plugin" });
  expect(plugin.receipt.startedBy).toBe("orca-plugin");
  // The sessions the tick launches do not inherit what started it.
  expect(plugin.starter).toBeNull();
  const unsaid = await started({});
  expect(unsaid.receipt.startedBy).toBeUndefined();
}, 120_000);
