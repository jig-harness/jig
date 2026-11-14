/**
 * The usage-limit walls interactive sessions meet. A session the runtime
 * reports waiting, launched with a vendor session id the tick minted
 * (`sessionId`), is read through the drive's quota adapters against its
 * account's configuration directory (`quota-probe.ts`, run as `run.ts
 * quota` in the account's environment). A wall found is:
 *
 * - a **waiting episode** of that session's own launch record (the state
 *   database's `waiting_episodes` table, keyed by the record and the wall's
 *   observation time: its reset, and whether the session's last record is
 *   still the wall), so every session behind one account's wall has its
 *   own, which the one nudge answers (`actions/steer.ts`);
 * - the account's wall (`walls.ts`), which admission reads, written once
 *   per episode: with the reset the adapter resolved, else `wall_backoff`
 *   from the wall's observation.
 *
 * A launch that carried no session id records no wall and gets no nudge.
 */
import { resolve } from "node:path";
import { run } from "../../shared/proc.ts";
import { passEnvironment } from "./accounts.ts";
import { agentOf } from "./actions/pickup-hold.ts";
import {
  isInteractive,
  type LaunchRecord,
  type ReadRecord,
  type WaitingEpisode,
} from "./launches.ts";
import { isProbedWall, type ProbedWall } from "./quota-probe.ts";
import { type SessionsReport, WAITING_STATES } from "./runtime/port.ts";
import type { ReadFailure } from "./types.ts";
import {
  CUT_AT_BOUND,
  ended,
  passedBefore,
  type TickBound,
  within,
} from "./sources/bounded.ts";
import { stateDb } from "./state.ts";
import { failureText } from "./text.ts";
import { type Wall, writeWall } from "./walls.ts";
import { currentIso, isoFromMs, parseMs } from "../../shared/time.ts";

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

/** The probe's command: `run.ts quota`, unless a test names another script. */
function probeCommand(): string[] {
  const script = process.env.JIG_DISPATCH_QUOTA_PROBE || RUN_TS;
  return [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    script,
    "quota",
  ];
}

/** The wall one session met, read in its account's environment; a string says why it could not be read. */
async function probe(
  r: ReadRecord,
  cwd: string,
  timeoutSec: number,
): Promise<ProbedWall | null | string> {
  const { record } = r;
  const done = await run(
    [...probeCommand(), record.sessionId as string, cwd, record.createdAt],
    { timeoutSec, env: passEnvironment(process.env, record), stderr: "pipe" },
  );
  if (done.code !== 0)
    return `the quota probe exited ${done.code}: ${done.stderr.trim().slice(0, 200)}`;
  try {
    const value: unknown = JSON.parse(done.stdout);
    if (value === null || isProbedWall(value)) return value;
  } catch (error) {
    return `the quota probe printed no answer: ${failureText(error)}`;
  }
  return "the quota probe printed something other than a wall";
}

/** Whether a record is a running interactive session launched with a session id the adapters can match. */
function readable(r: ReadRecord): boolean {
  const { record } = r;
  return (
    isInteractive(record) &&
    r.state.kind === "alive" &&
    record.vendor === "claude" &&
    typeof record.sessionId === "string"
  );
}

/** The workspace of an interactive session the tick can read a wall for, whose agent waits; `null` otherwise. */
function waitingSession(
  r: ReadRecord,
  sessions: SessionsReport,
): string | null {
  const { agentId, workspace } = r.record;
  if (!readable(r) || agentId === null || workspace === null) return null;
  const state = agentOf(sessions, agentId)?.agent.state;
  return state !== undefined && WAITING_STATES.has(state)
    ? workspace.path
    : null;
}

/**
 * Read the wall of each of `repo`'s waiting interactive sessions, keeping
 * a waiting episode on its record and the account's wall; returns what
 * could not be read, for the report: a read the tick's bound ended carries
 * its `unreachable` class, so the failure ledger counts it.
 */
export async function observeWalls(
  records: ReadRecord[],
  repo: string,
  sessions: SessionsReport,
  timeoutSec: number,
  root?: string,
  bound?: TickBound,
): Promise<WallFailure[]> {
  const failures: WallFailure[] = [];
  for (const r of records) {
    if (r.record.repo !== repo) continue;
    const cwd = waitingSession(r, sessions);
    if (cwd === null) continue;
    // A probe is neither started nor awaited past the tick's bound.
    const found = await probeHeldTo(r, cwd, timeoutSec, bound);
    const failure = wallFailure(r.record.id, found);
    if (failure !== null) {
      failures.push(failure);
      // Without a successful read this tick cannot say the wall is still the
      // session's last record, so no earlier reading may authorize a nudge.
      wentOn(r, currentIso(), root);
      continue;
    }
    keepEpisode(r, found as ProbedWall | null, root);
  }
  return failures;
}

/** The failure a probe's answer is, or `null` for a wall (or none) it read. */
function wallFailure(
  id: string,
  found: Awaited<ReturnType<typeof probeHeldTo>>,
): WallFailure | null {
  if (typeof found === "string")
    return { reason: `launch record ${id}: ${found}` };
  if (found !== null && "cut" in found)
    return {
      reason: `launch record ${id}: ${found.cut}`,
      failure: CUT_AT_BOUND,
    };
  return null;
}

/** A wall read that could not be made, and the failure class when the tick's bound ended it. */
export interface WallFailure {
  reason: string;
  failure?: ReadFailure;
}

/** A read the tick's bound ended, in the words that say which. */
interface Cut {
  cut: string;
}

/** `probe`, or why the tick's bound kept it from reading. */
async function probeHeldTo(
  r: ReadRecord,
  cwd: string,
  timeoutSec: number,
  bound: TickBound | undefined,
): Promise<Awaited<ReturnType<typeof probe>> | Cut> {
  if (bound === undefined) return probe(r, cwd, timeoutSec);
  if (ended(bound)) return { cut: passedBefore("its wall was read") };
  try {
    return await within(probe(r, cwd, timeoutSec), bound);
  } catch (error) {
    if (!bound.signal.aborted) throw error;
    return { cut: `the tick's deadline passed during its wall's read` };
  }
}

/** The session went on past its last wall, never met one, or could not be read this tick: its latest episode is not known to be its last record. */
function wentOn(r: ReadRecord, readAt: string, root?: string): void {
  const { record } = r;
  const episodes = record.episodes ?? [];
  const latest = episodes.at(-1);
  if (latest === undefined || !latest.last) return;
  stateDb(root)
    .query(
      "UPDATE waiting_episodes SET last = 0, read_at = ? WHERE launch = ? AND observed_at = ?",
    )
    .run(readAt, record.id, latest.observedAt);
  record.episodes = [
    ...episodes.slice(0, -1),
    { ...latest, last: false, readAt },
  ];
}

/** Keep an episode: a new wall is a new row, the same wall read again updates its own. */
function writeEpisode(
  record: LaunchRecord,
  episode: WaitingEpisode,
  root?: string,
): void {
  stateDb(root)
    .query(
      `INSERT INTO waiting_episodes (launch, observed_at, reset_at, evidence, last, read_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (launch, observed_at) DO UPDATE SET
         reset_at = excluded.reset_at, evidence = excluded.evidence,
         last = excluded.last, read_at = excluded.read_at`,
    )
    .run(
      record.id,
      episode.observedAt,
      episode.resetAt,
      episode.evidence,
      episode.last ? 1 : 0,
      episode.readAt,
    );
}

/** The account's wall a new episode closes it with: the resolved reset, else `wall_backoff` from the wall. */
function accountWallOf(record: LaunchRecord, found: ProbedWall): Wall {
  const known = found.resetAt !== null;
  return {
    account: record.account,
    vendor: record.vendor,
    configDir: record.configDir,
    resetAt: known
      ? (found.resetAt as string)
      : isoFromMs(parseMs(found.observedAt) + record.wallBackoffMs),
    source: known
      ? `interactive session ${record.id}: ${found.evidence}`
      : `interactive session ${record.id}: no reset resolved; wall_backoff from ${found.observedAt}`,
  };
}

/** Keep what the probe found on the record, and a new episode's wall on the account. */
function keepEpisode(
  r: ReadRecord,
  found: ProbedWall | null,
  root?: string,
): void {
  const readAt = currentIso();
  if (found === null) {
    wentOn(r, readAt, root);
    return;
  }
  const { record } = r;
  const episodes = record.episodes ?? [];
  const episode: WaitingEpisode = {
    observedAt: found.observedAt,
    resetAt: found.resetAt,
    evidence: found.evidence,
    last: found.last,
    readAt,
  };
  const same = episodes.at(-1)?.observedAt === found.observedAt;
  // The account's wall first: a stop between the two writes leaves no
  // episode, so the next tick finds the wall as new and publishes both.
  if (!same) writeWall(accountWallOf(record, found), root);
  writeEpisode(record, episode, root);
  record.episodes = same
    ? [...episodes.slice(0, -1), episode]
    : [...episodes, episode];
}
