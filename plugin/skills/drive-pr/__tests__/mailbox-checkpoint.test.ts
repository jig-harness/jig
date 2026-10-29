/**
 * The driver's mailbox checkpoint (`lib/driver/mailbox.ts`): a pause keeps the
 * drive's ledger heartbeat renewed, a clear checkpoint writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitAtMailboxCheckpoint } from "../scripts/lib/driver/mailbox.ts";
import { appendDirective } from "../scripts/lib/state/mailbox.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-pr-mailbox-checkpoint-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("waitAtMailboxCheckpoint", () => {
  it("renews the ledger heartbeat while paused, and not at a clear checkpoint", async () => {
    let renewals = 0;
    const renew = async () => {
      renewals += 1;
    };
    expect(await waitAtMailboxCheckpoint(dir, "999", 1, renew)).toBe("clear");
    expect(renewals).toBe(0);
    await appendDirective(dir, "999", "orchestrator", "pause");
    expect(await waitAtMailboxCheckpoint(dir, "999", 1, renew)).toBe(
      "pause-timeout",
    );
    expect(renewals).toBeGreaterThan(0);
  });
});
