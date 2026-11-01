/**
 * The usage-limit walls interactive sessions meet. A session the runtime
 * reports waiting, launched with a vendor session id the tick minted
 * (`sessionId`), is read through the drive's quota adapters against its
 * account's configuration directory (`quota-probe.ts`, run as `run.ts
 * quota` in the account's environment). A wall found is:
 *
 * - a **waiting episode** on that session's own launch record (the wall's
 *   observation time, its reset, and whether the session's last record is
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
  writeRecord,
} from "./launches.ts";
import { isProbedWall, type ProbedWall } from "./quota-probe.ts";
import { type SessionsReport, WAITING_STATES } from "./runtime/port.ts";
import { failureText } from "./text.ts";
import { type Wall, writeWall } from "./walls.ts";

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
 * could not be read, for the report.
 */
export async function observeWalls(
  records: ReadRecord[],
  repo: string,
  sessions: SessionsReport,
  timeoutSec: number,
  root?: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const r of records) {
    if (r.record.repo !== repo) continue;
    const cwd = waitingSession(r, sessions);
    if (cwd === null) continue;
    const found = await probe(r, cwd, timeoutSec);
    if (typeof found === "string") {
      failures.push(`launch record ${r.record.id}: ${found}`);
      continue;
    }
    keepEpisode(r, found, root);
  }
  return failures;
}

/** The session went on past its last wall, or never met one: its latest episode is no longer its last record. */
function wentOn(r: ReadRecord, readAt: string, root?: string): void {
  const { record } = r;
  const episodes = record.episodes ?? [];
  const latest = episodes.at(-1);
  if (latest === undefined || !latest.last) return;
  record.episodes = [
    ...episodes.slice(0, -1),
    { ...latest, last: false, readAt },
  ];
  writeRecord(record, root);
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
      : new Date(
          Date.parse(found.observedAt) + record.wallBackoffMs,
        ).toISOString(),
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
  const readAt = new Date().toISOString();
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
  record.episodes = same
    ? [...episodes.slice(0, -1), episode]
    : [...episodes, episode];
  writeRecord(record, root);
  if (!same) writeWall(accountWallOf(record, found), root);
}
