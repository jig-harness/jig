/** A deliberate stop may terminate only ownership that its recovery can publish. */
import { readConfig } from "../../../../../shared/consumer.ts";
import { dispatchSection } from "../../../../../dispatch/lib/section.ts";
import { commandLabel } from "../../../../../shared/pr-labels/projection.ts";
import type { ClaimDiag } from "../claim.ts";
import { worktreePathKey } from "./actor.ts";
import { personStopFor } from "./person-stop.ts";
import { ledgerOfStoppedDriver } from "./ledger.ts";
import {
  readLedgerSnapshot,
  resolveLogin,
  writeLedger,
} from "./ledger-forge.ts";
import { cloneId } from "./ledger-mirror.ts";
import { currentIso } from "../../../../../shared/time.ts";

/** A startup whose predecessor still owns the ledger must publish before it is stopped. */
export async function canStopPublishedDriver(row: {
  stateDir: string;
  key: string;
  diag: ClaimDiag | null;
}): Promise<boolean> {
  if (process.env.DRIVE_PR_LEDGER === "off") return true;
  try {
    const diag = row.diag;
    const snapshot = await readLedgerSnapshot(row.key, await resolveLogin());
    const ownership =
      typeof snapshot === "string" || diag === null
        ? {
            why:
              typeof snapshot === "string"
                ? snapshot
                : "the claim carries no diagnostics",
          }
        : ledgerOfStoppedDriver(snapshot, {
            actor: `wt-${worktreePathKey(diag.worktree)}`,
            clone: cloneId(row.stateDir),
            started: diag.started,
          });
    if (
      !("why" in ownership) &&
      diag?.started !== "" &&
      ownership.ledger.driver.started === diag?.started &&
      ownership.ledger.driver.recoveryVersion === 1
    )
      return true;
    const why =
      "why" in ownership
        ? ownership.why
        : "the ledger does not record this exact acquisition with the current stop-publication capability; hold dispatch and re-arm with the current plugin";
    const section = dispatchSection(readConfig());
    if (!section.ok) {
      unverified(row.key, `Error: ${section.failure.reason}`);
      return false;
    }
    const labels = section.value.labels;
    console.log(
      `refusing to stop PR #${row.key}: this acquisition has not published its running ownership, or its ledger no longer belongs to it (${why}). No stop was sent or recorded. Retry after startup publishes its ledger; to keep dispatch off meanwhile, add the configured hold label ${commandLabel(labels, "hold")} when dispatch labels are enabled.`,
    );
  } catch (error) {
    unverified(row.key, String(error));
  }
  return false;
}

/** Say that a stop is refused because the ledger's ownership, or what the refusal names, could not be read: `detail` says what failed. */
function unverified(key: string, detail: string): void {
  console.log(
    `refusing to stop PR #${key}: its ledger ownership could not be verified (${detail}). No stop was sent or recorded. Retry once the ledger reads; use the repository's configured dispatch hold label to prevent automatic re-arms meanwhile.`,
  );
}

/** Publish intent without changing the canonical resumable state or claiming termination. */
export async function publishOperatorStop(row: {
  stateDir: string;
  key: string;
  diag: ClaimDiag | null;
}): Promise<boolean> {
  const diag = row.diag;
  if (diag === null) return false;
  const marker = personStopFor(row.stateDir, row.key, diag.started).personStop;
  if (marker === undefined) return false;
  const who = {
    actor: `wt-${worktreePathKey(diag.worktree)}`,
    clone: cloneId(row.stateDir),
    started: diag.started,
  };
  const login = await resolveLogin();
  const written = await writeLedger(row.key, login, (snapshot) => {
    const owned = ledgerOfStoppedDriver(snapshot, who, true);
    if ("why" in owned) return owned.why;
    if (
      owned.ledger.driver.started !== diag.started ||
      owned.ledger.driver.recoveryVersion !== 1
    )
      return "the canonical ledger no longer names this acquisition with stop-publication support";
    return {
      ...owned.ledger,
      generation: snapshot.maxGeneration + 1,
      driver: {
        ...owned.ledger.driver,
        personStop: marker,
        heartbeat: currentIso(),
      },
    };
  });
  if (written.kind !== "written") {
    console.log(
      `operator stop was not published: ${written.reason}; no signal sent; hold dispatch and retry.`,
    );
    return false;
  }
  const verified = await readLedgerSnapshot(row.key, login);
  if (typeof verified === "string") {
    console.log(`operator stop could not be verified: ${verified}`);
    return false;
  }
  const owned = ledgerOfStoppedDriver(verified, who, true);
  if ("why" in owned) {
    console.log(`operator stop could not be verified: ${owned.why}`);
    return false;
  }
  const stop = owned.ledger.driver.personStop;
  return (
    stop?.at === marker.at &&
    stop.reason === marker.reason &&
    owned.ledger.driver.started === diag.started
  );
}
