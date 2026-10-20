import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { leasePathFor, treeLeasePathFor } from "../scripts/lib/state/lease";

import { ACTOR } from "./drive-pr-harness.ts";

import type { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
export function createStateSessionLeaseFixtures(
  parent: ReturnType<typeof createStateDurabilityFixtures>,
) {
  const { state } = parent;

  // The actor a hold records is the WORKING TREE, and `drive.ts`'s
  // single-instance lock is keyed by the same tree — so the model assumes one
  // tree = one driver. An INTERACTIVE pass takes no lock, so two agent
  // sessions in ONE tree both stamp the same actor: `hold` upserts by key and
  // the second silently REPLACES the first's record, `stamp-held` stamps
  // both sessions' holds, and nothing in the claim path can tell them apart.
  // Measured (2026-08-13): all seventeen threads one session had just
  // replied to carried two `**accepted**` replies.
  //
  // Every probe below drives the identity through $DRIVE_PR_SESSION, which is
  // also the channel drive.ts itself uses (see the loop-control block), so a
  // "session" here is a real pid whose liveness the probe controls.

  /**
   * A pid that is definitively GONE: a child spawned only to be waited on.
   * Any literal would be a guess about the machine running the suite.
   */
  async function deadPid(): Promise<number> {
    const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return p.pid;
  }

  const A_URL = "https://example.invalid/session-a-reply";

  const B_URL = "https://example.invalid/session-b-reply";

  /** Hold one thread key, as `session`. */
  function holdAs(dir: string, pid: number, url: string) {
    return state(
      dir,
      [
        "hold",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        url,
      ],
      { DRIVE_PR_SESSION: String(pid) },
    );
  }

  /**
   * Backdate BOTH leases a session holds — the per-PR one and the
   * tree-wide one — to the same `lastSeen`, so a probe simulating
   * "this session has gone quiet" models a real quiet session rather than
   * leaving the tree lease fresh and refusing on that layer instead of the
   * one under test (`claimTreeLease` runs BEFORE the per-PR claim, so a
   * still-fresh tree lease shadows a deliberately-backdated per-PR one).
   */
  function backdateSessionLeases(dir: string, pr: string, ms: number): void {
    const when = new Date(Date.now() - ms).toISOString();
    for (const path of [
      leasePathFor(dir, pr, ACTOR),
      treeLeasePathFor(dir, ACTOR),
    ]) {
      const lease = JSON.parse(readFileSync(path, "utf8"));
      lease.lastSeen = when;
      writeFileSync(path, JSON.stringify(lease, null, 2));
    }
  }

  /**
   * Hold a mutating command inside its locked section until `then()` has run,
   * so a takeover can be raced into the window between admission and mutation.
   */
  async function stalledMutation(
    d: string,
    sessionPid: number,
    name: string,
    then: () => Promise<void> | void,
  ) {
    const signal = join(d, `${name}-is-holding`);
    // `then()` acts in this process the moment the signal appears, so the
    // stall only has to outlast a 10ms poll and that action.
    const running = state(d, ["bump-round", "999", "--head", "bbb"], {
      DRIVE_PR_SESSION: String(sessionPid),
      DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
      DRIVE_PR_UPDATE_TEST_DELAY: "1.5",
    });
    const deadline = Date.now() + 8000;
    while (!existsSync(signal)) {
      if (Date.now() > deadline) {
        throw new Error("the mutation never signalled that it holds the lock");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await then();
    return running;
  }
  return {
    deadPid,
    A_URL,
    B_URL,
    holdAs,
    backdateSessionLeases,
    stalledMutation,
  };
}
