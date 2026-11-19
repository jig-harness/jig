import { describe, expect, test } from "bun:test";
import { failed } from "../../../shared/outcome.ts";
import { recoveryRead } from "../scripts/lib/cancelled-recovery-reads.ts";

describe("recoveryRead stops asking when the failure cannot clear by waiting", () => {
  const ask = (calls: { n: number }) => async () => {
    calls.n += 1;
    return failed("too-costly" as const, "more than 100 pages");
  };

  test("a settled failure is asked once", async () => {
    const calls = { n: 0 };
    process.env.DRIVE_PR_RECOVERY_READ_RETRY_MS = "10";
    const read = await recoveryRead("check runs", ask(calls), () => true);
    expect(read.ok).toBe(false);
    expect(calls.n).toBe(1);
  });

  test("an unsettled transient failure is still asked again", async () => {
    const calls = { n: 0 };
    process.env.DRIVE_PR_RECOVERY_READ_RETRY_MS = "10";
    await recoveryRead("check runs", ask(calls), () => false);
    expect(calls.n).toBe(2);
  });
});
