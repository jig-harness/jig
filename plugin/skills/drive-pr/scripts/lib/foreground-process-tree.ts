import { recaptureOwned, type Target } from "./process-witness.ts";
import type { ProcessRow } from "../../../../shared/process-table.ts";
import {
  liveOrUnknownTargets,
  partitionProcessTree,
  trackPartitionUncertainty,
  trackUnknownDescendants,
} from "../../../../shared/process-uncertainty.ts";
export interface ForegroundTreeState {
  root: Target | null;
  targets: Target[];
  unknown: Set<number>;
  unresolved: boolean;
  unverifiable: boolean;
}
/** Retain ownership evidence across snapshots without adopting a reused root. */
export function trackForegroundProcessTree(
  pid: number,
  reaped: boolean,
  rows: ProcessRow[] | null,
  state: ForegroundTreeState,
): void {
  if (rows === null) {
    state.unresolved = true;
    return;
  }
  const retained = liveOrUnknownTargets(state.targets, rows);
  trackUnknownDescendants(
    retained.map((target) => ({
      pid: target.pid,
      start: rows.find((row) => row.pid === target.pid)?.start ?? "",
    })),
    rows,
    state.unknown,
  );
  const current = rows.find((row) => row.pid === pid);
  if (current?.start === "") {
    trackPartitionUncertainty(
      partitionProcessTree(pid, rows),
      rows,
      state.unknown,
    );
    state.targets = retained;
    state.unresolved = true;
    return;
  }
  const captured = recaptureOwned(pid, state.root, reaped, rows);
  if (captured.kind === "unverifiable") state.unverifiable = true;
  if (captured.kind === "tree") {
    state.root = captured.root;
    if (current?.start === captured.root.start) {
      const partition = partitionProcessTree(pid, rows);
      trackPartitionUncertainty(partition, rows, state.unknown);
      for (const row of partition.targets)
        if (
          !retained.some(
            (target) => target.pid === row.pid && target.start === row.start,
          )
        )
          retained.push({ pid: row.pid, start: row.start });
    }
  }
  state.targets = retained;
  state.unresolved = state.unknown.size > 0;
}
