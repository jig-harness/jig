/**
 * `jig doctor`'s dispatch check of the tracker credential: a Linear-tracked
 * repository whose ticks ran with no Linear key within the last day is
 * reported with the count of those ticks and the callers that had no key.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_CREDENTIAL } from "../../shared/outbound/credential-latch.ts";
import { recordCall } from "../../shared/outbound/ledger.ts";
import { isoFromMs } from "../../shared/time.ts";
import { keylessCheck } from "../lib/keyless-doctor.ts";
import { type TickReceipt, writeReceipt } from "../receipts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const HOUR = 3_600_000;

function receipt(runId: string, atMs: number, keyless: boolean): TickReceipt {
  return {
    version: 1,
    runId,
    startedAt: isoFromMs(atMs),
    finishedAt: isoFromMs(atMs),
    completed: true,
    apply: true,
    exitStatus: keyless ? 9 : 0,
    ...(keyless
      ? {
          noCredential: [
            {
              system: "linear",
              class: "unauthorized",
              reason: "no Linear key configured",
              remedy:
                "set LINEAR_API_KEY (or LINEAR_API_TOKEN), or log in to the `linear` command-line client",
              repos: ["example-org/tracked"],
            },
          ],
        }
      : {}),
    repos: [],
  };
}

const id = (atMs: number, tag: string) =>
  `${isoFromMs(atMs).replace(/[:.]/g, "-")}-1-${tag}`;

function fixture(): { root: string; ledger: string } {
  const root = mkdtempSync(join(tmpdir(), "jig-keyless-doctor-"));
  roots.push(root);
  return { root, ledger: join(root, "budget.sqlite") };
}

test("reports no Linear key configured for a repository whose ticks ran keyless, with their count and callers", () => {
  const { root, ledger } = fixture();
  const first = id(NOW - HOUR, "aaaaaaaa");
  const second = id(NOW - 2 * HOUR, "bbbbbbbb");
  writeReceipt(receipt(first, NOW - HOUR, true), root);
  writeReceipt(receipt(second, NOW - 2 * HOUR, true), root);
  writeReceipt(
    receipt(id(NOW - 3 * HOUR, "cccccccc"), NOW - 3 * HOUR, false),
    root,
  );
  // Older than the report's window: not counted.
  const old = id(NOW - 30 * HOUR, "dddddddd");
  writeReceipt(receipt(old, NOW - 30 * HOUR, true), root);
  for (const caller of [`tick:${first}`, `tick:${second}`, "skill:tracker.ts"])
    recordCall({
      path: ledger,
      system: "linear",
      credential: NO_CREDENTIAL,
      operation: "TrackerNativeQueue",
      caller,
      unit: "points",
      requests: 0,
      cost: null,
      durationMs: 0,
      failure: "unauthorized",
      at: NOW - HOUR,
    });
  const check = keylessCheck({ root, ledgerPath: ledger, nowMs: NOW });
  expect(check.id).toBe("dispatch:tracker-credential");
  expect(check.status).toBe("fail");
  expect(check.detail).toContain("no Linear key configured");
  expect(check.detail).toContain("example-org/tracked");
  expect(check.detail).toContain("2 ticks");
  expect(check.detail).toContain(`tick:${first}`);
  expect(check.detail).toContain(`tick:${second}`);
  expect(check.detail).toContain("skill:tracker.ts");
  expect(check.detail).not.toContain(old);
  expect(check.fix).toContain("LINEAR_API_KEY");
});

test("passes when no tick in the window ran without a tracker credential", () => {
  const { root, ledger } = fixture();
  writeReceipt(receipt(id(NOW - HOUR, "eeeeeeee"), NOW - HOUR, false), root);
  const check = keylessCheck({ root, ledgerPath: ledger, nowMs: NOW });
  expect(check.status).toBe("pass");
});
