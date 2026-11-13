/** Reap only a closed fixture membership whose test runner has exited. */
import { judge, type ProcessIdentity } from "./liveness.ts";
import { failureFields } from "./errors.ts";
import { log } from "./log.ts";
import { processTable, type ProcessRow } from "./process-table.ts";
import {
  signalIdentityTargets,
  type ProcessTreeControl,
} from "./process-tree.ts";
import {
  readClosedFixtureMembership,
  type FixtureProof,
} from "./test-fixture-registry.ts";

type Inspection = { proof: FixtureProof; targets: ProcessIdentity[] };
function inspect(
  root: string,
  registry: string,
  rows: ProcessRow[] | null,
): Inspection {
  const membership = readClosedFixtureMembership(root, registry);
  const uncertain = (reason: string): Inspection => ({
    proof: { state: "unverified", reason },
    targets: [],
  });
  if (!membership.ok) {
    if (membership.failure.cause !== undefined)
      log.warn(
        "cannot inspect fixture membership",
        failureFields(membership.failure.cause),
      );
    return uncertain(membership.failure.reason);
  }
  const owner = judge(membership.value.owner, rows);
  if (!owner.ok) return uncertain(owner.failure.reason);
  if (owner.value.state === "alive")
    return {
      proof: { state: "live", reason: "the registered test runner still runs" },
      targets: [],
    };
  const targets: ProcessIdentity[] = [];
  for (const child of membership.value.children) {
    const alive = judge(child, rows);
    if (!alive.ok) return uncertain(alive.failure.reason);
    if (alive.value.state === "alive") {
      if (child.pid === process.pid)
        return {
          proof: {
            state: "live",
            reason: "this collector belongs to the registered fixture tree",
          },
          targets: [],
        };
      targets.push(child);
    }
  }
  return {
    proof: {
      state: "dead",
      reason: targets.length
        ? `the test runner exited; ${targets.length} registered fixture process(es) require reaping`
        : "every process in the closed fixture membership has exited",
    },
    targets,
  };
}

/** Eligibility for the process resource, not a claim that scratch has no holders. Read-only. */
export async function orphanFixtureProof(
  root: string,
  registry: string,
): Promise<FixtureProof> {
  return inspect(root, registry, await processTable()).proof;
}

/**
 * Caller holds scratch's exclusive lock, so participating children cannot
 * launch more work between the membership check and the final witness.
 * Opaque native launches and unfinished child acknowledgements prevent force.
 */
export async function reapFixtureScope(
  root: string,
  registry: string,
  deps: ProcessTreeControl = {},
): Promise<FixtureProof> {
  const now = deps.now ?? Date.now;
  const deadline = deps.deadline ?? now() + (deps.timeoutMs ?? 10_000);
  const remaining = () => Math.max(0, deadline - now());
  const read = deps.table ?? processTable;
  const table = async (): Promise<ProcessRow[] | null> => {
    const left = remaining();
    if (left === 0) return null;
    const rows = await read(Math.min(5, left / 1000));
    return remaining() > 0 ? rows : null;
  };
  while (remaining() > 0) {
    const current = inspect(root, registry, await table());
    if (current.proof.state !== "dead" || current.targets.length === 0)
      return current.proof;
    // Host, boot and creation identity were judged before selecting targets.
    // The shared signal primitive reads creation identities again before each force.
    const signalled = await signalIdentityTargets(current.targets, "SIGKILL", {
      ...deps,
      now,
      deadline,
      table,
    });
    if (!signalled)
      return {
        state: "unverified",
        reason: "registered fixture termination could not be confirmed",
      };
    const after = inspect(root, registry, await table());
    if (after.proof.state !== "dead" || after.targets.length === 0)
      return after.proof;
    const delay = Math.min(50, remaining());
    if (delay > 0)
      await (
        deps.pause ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(delay);
  }
  return {
    state: "unverified",
    reason: "registered fixture processes survived the reaping deadline",
  };
}
