import { expect, it } from "bun:test";
import { runRoundIteration } from "../scripts/lib/driver/round-step.ts";
import type { DriveRoundContext } from "../scripts/lib/driver/round-context.ts";

it("honors a local stop before waiting on any remote CI or control observation", async () => {
  let checked = false;
  // Every other dependency is deliberately absent: consulting the forge or
  // the cached CI wait before this stop would fail instead of returning it.
  const context = {
    mailboxCheckpoint: async () => {
      checked = true;
      return 18;
    },
  } as unknown as DriveRoundContext;
  expect(await runRoundIteration(context, [], [], 2, 1)).toBe(18);
  expect(checked).toBe(true);
});
