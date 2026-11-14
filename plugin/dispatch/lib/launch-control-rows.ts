/**
 * What Control adds to the launch records while they run: a drive's
 * unresolved-thread count per ledger round (`thread_samples`) and an
 * interactive session's usage-limit walls (`waiting_episodes`), read per
 * launch in the order they were first written.
 */
import type { Database } from "bun:sqlite";
import type { LaunchRecord, ThreadSample, WaitingEpisode } from "./launches.ts";
import { stateDb } from "./state.ts";

interface EpisodeRow {
  launch: string;
  observed_at: string;
  reset_at: string | null;
  evidence: string;
  last: number;
  read_at: string;
}

export type ControlRows = Pick<LaunchRecord, "samples" | "episodes">;

export const EMPTY: ControlRows = { samples: [], episodes: [] };

/** The thread samples and waiting episodes of one launch, or of every launch, in the order they were first written. */
export function controlRows(
  root: string,
  id?: string,
  db: Database = stateDb(root),
): Map<string, ControlRows> {
  const where = id === undefined ? "" : "WHERE launch = ?";
  const args = id === undefined ? [] : [id];
  const out = new Map<string, ControlRows>();
  const of = (launch: string) => {
    let rows = out.get(launch);
    if (rows === undefined) {
      rows = { samples: [], episodes: [] };
      out.set(launch, rows);
    }
    return rows;
  };
  const samples = db
    .query(
      `SELECT launch, round, threads, at FROM thread_samples ${where} ORDER BY rowid`,
    )
    .all(...args) as Array<ThreadSample & { launch: string }>;
  for (const { launch, round, threads, at } of samples)
    (of(launch).samples as ThreadSample[]).push({ round, threads, at });
  const episodes = db
    .query(
      `SELECT launch, observed_at, reset_at, evidence, last, read_at
       FROM waiting_episodes ${where} ORDER BY rowid`,
    )
    .all(...args) as EpisodeRow[];
  for (const e of episodes)
    (of(e.launch).episodes as WaitingEpisode[]).push({
      observedAt: e.observed_at,
      resetAt: e.reset_at,
      evidence: e.evidence,
      last: e.last === 1,
      readAt: e.read_at,
    });
  return out;
}
