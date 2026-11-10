/**
 * The memory samples each kind of launch's reservation is measured from
 * (`load_samples` in the state database): one sample per running session
 * per tick, the bytes its workspace's processes used. Only the newest
 * `KEPT` samples of each kind are kept, and a kind's reservation is the
 * 90th percentile of them once it has `MEASURED_AFTER`; until then its
 * default stands.
 */
import { stateRoot } from "../receipts.ts";
import type { LoadKind } from "./dashboard-contract.ts";
import { LOAD_KINDS } from "./load-config.ts";
import { inTransaction, stateDb } from "./state.ts";

/** The samples a kind keeps. */
export const KEPT = 20;
/** The samples a kind needs before its own measure replaces its default. */
export const MEASURED_AFTER = 5;

/** One running session's memory at this tick. */
export interface LoadSample {
  kind: LoadKind;
  record: string;
  bytes: number;
}

/** The 90th percentile of `values` (nearest rank); `null` for none. */
export function percentile90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? null;
}

/** Record this tick's samples, keeping only each kind's newest `KEPT`. */
export function recordSamples(
  samples: readonly LoadSample[],
  nowMs: number,
  root = stateRoot(),
): void {
  if (samples.length === 0) return;
  const db = stateDb(root);
  inTransaction(db, () => {
    const insert = db.query(
      "INSERT INTO load_samples (kind, record, at_ms, bytes) VALUES (?, ?, ?, ?)",
    );
    for (const s of samples) insert.run(s.kind, s.record, nowMs, s.bytes);
    const trim = db.query(
      `DELETE FROM load_samples WHERE kind = ? AND seq NOT IN
         (SELECT seq FROM load_samples WHERE kind = ? ORDER BY seq DESC LIMIT ?)`,
    );
    for (const kind of new Set(samples.map((s) => s.kind)))
      trim.run(kind, kind, KEPT);
  });
}

/** Each kind's newest samples, newest first. */
export function readSamples(root = stateRoot()): Map<LoadKind, number[]> {
  const db = stateDb(root);
  const read = db.query(
    "SELECT bytes FROM load_samples WHERE kind = ? ORDER BY seq DESC LIMIT ?",
  );
  return new Map(
    LOAD_KINDS.map((kind) => [
      kind,
      (read.all(kind, KEPT) as Array<{ bytes: number }>).map((r) => r.bytes),
    ]),
  );
}
