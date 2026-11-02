/**
 * The `steer` stage: the closed set of nudges (`NUDGES`, one entry,
 * **continue**) sent to a session that waits after its account's wall
 * reopened. The tick plans a nudge for an interactive session this machine
 * launched only when all of these hold: the runtime reports its agent
 * waiting; the latest waiting episode on its launch record (`session-walls.ts`)
 * has reached its reset; and the session's last record is still that wall.
 * With `--apply`, for a repository whose machine-file stages include
 * `steer`, the runtime's `steer` re-reads the screen and the attachment in
 * the same call and types the text.
 *
 * - **Once per episode.** Before the send, a suppression record keyed by
 *   the session and its episode is written, pending (the state database's
 *   `nudges` table, whose key refuses a second); its delivery is marked
 *   after (delivered, or not known to have arrived), once. A send whose
 *   answer is lost, or a tick that stopped between the two, never leads to
 *   a second one: a pending record a later tick finds is marked not known
 *   to have arrived. A check that failed before any send removes the
 *   pending record, since nothing was typed.
 * - **Then a person.** A nudge not known to have arrived, or a session
 *   still waiting on the same episode after its nudge, is notified; it is
 *   never nudged again.
 * - **Logged.** Each nudge's event row is written in the same transaction
 *   as its delivery mark, so the log never reads an attempted nudge as a
 *   delivered one, and never lacks a nudge whose delivery is marked.
 *
 * There is no open-ended nudge: every other stuck state is a notification.
 */
import { stateRoot } from "../../receipts.ts";
import {
  isInteractive,
  type ReadRecord,
  targetOf,
  type WaitingEpisode,
} from "../launches.ts";
import { insertRow } from "../log.ts";
import { pickupNotice } from "../notices.ts";
import {
  type RuntimeReceipt,
  type SessionsReport,
  WAITING_STATES,
} from "../runtime/port.ts";
import { inTransaction, stateDb } from "../state.ts";
import { failureText } from "../text.ts";
import type { Action, RepoReport, Running, SteerOutcome } from "../types.ts";
import { agentOf } from "./pickup-hold.ts";
import { type ApplyState, outOfTime } from "./launch.ts";

/** A nudge's suppression record, with its delivery mark once written. */
export interface NudgeRecord {
  repo: string;
  record: string;
  target: string;
  account: string;
  episode: string;
  at: string;
  delivery: "pending" | "delivered" | "unknown";
  detail: string;
}

/** The nudges of `repo`, by record and episode. */
export function readNudges(
  repo: string,
  root = stateRoot(),
): Map<string, NudgeRecord> {
  const rows = stateDb(root)
    .query(
      `SELECT repo, record, target, account, episode, at, delivery, detail
       FROM nudges WHERE repo = ?`,
    )
    .all(repo) as NudgeRecord[];
  return new Map(rows.map((n) => [nudgeKey(n.record, n.episode), n]));
}

function nudgeKey(record: string, episode: string): string {
  return `${record} ${episode}`;
}

/**
 * Mark a pending nudge's delivery, and write its event row in the same
 * transaction; a nudge already marked keeps its mark, and gets no row.
 */
function markDelivery(
  nudge: NudgeRecord,
  delivery: "delivered" | "unknown",
  detail: string,
  root: string,
): void {
  const db = stateDb(root);
  inTransaction(db, () => {
    const marked = db
      .query(
        `UPDATE nudges SET delivery = ?, detail = ?
         WHERE record = ? AND episode = ? AND delivery = 'pending'`,
      )
      .run(delivery, detail, nudge.record, nudge.episode);
    if (marked.changes !== 1) return;
    insertRow(db, {
      kind: "event",
      key: `nudge ${nudge.record} ${nudge.episode}`,
      at: nudge.at,
      repo: nudge.repo,
      stage: "steer",
      target: nudge.target,
      event: "nudge",
      account: nudge.account,
      class: null,
      reason: `continue ${delivery === "delivered" ? "delivered" : "sent, not known to have arrived"}: ${detail}`,
    });
  });
}

/**
 * Mark each nudge of `repo` still pending (a tick stopped between the send
 * and its mark) as not known to have arrived, with its event row.
 */
export function settlePending(
  nudges: Map<string, NudgeRecord>,
  root = stateRoot(),
): string[] {
  const failed: string[] = [];
  for (const nudge of nudges.values()) {
    if (nudge.delivery !== "pending") continue;
    const detail = "a later tick found the send without its answer";
    try {
      markDelivery(nudge, "unknown", detail, root);
      nudge.delivery = "unknown";
      nudge.detail = detail;
    } catch (error) {
      failed.push(
        `the nudge of ${nudge.record} stays pending: ${failureText(error)}`,
      );
    }
  }
  return failed;
}

export interface SteerInput {
  slug: string;
  launches: ReadRecord[];
  sessions: SessionsReport;
  nudges: ReadonlyMap<string, NudgeRecord>;
  nowMs: number;
}

/** The latest waiting episode of an interactive session whose agent the runtime reports waiting. */
function waitingOn(
  r: ReadRecord,
  sessions: SessionsReport,
): { episode: WaitingEpisode; agent: string; workspace: string } | null {
  const { record } = r;
  if (!isInteractive(record) || r.state.kind !== "alive") return null;
  if (record.agentId === null) return null;
  const episode = record.episodes?.at(-1);
  if (episode === undefined) return null;
  const found = agentOf(sessions, record.agentId);
  if (found === undefined || !WAITING_STATES.has(found.agent.state))
    return null;
  return { episode, agent: record.agentId, workspace: found.workspace.path };
}

/** The notification that a delivered nudge did not settle the wait, while the session's last record is still the wall; a session that went on waits on something else now. */
function unansweredWhileWaiting(
  input: SteerInput,
  r: ReadRecord,
  nudge: NudgeRecord,
  episode: WaitingEpisode,
): Action[] {
  const workspace = r.record.workspace?.path;
  return episode.last ? [unanswered(input, r, nudge, workspace)] : [];
}

/** A notification that a nudge did not settle the wait. */
function unanswered(
  input: SteerInput,
  r: ReadRecord,
  nudge: NudgeRecord,
  workspace: string | undefined,
): Action {
  const target = targetOf(r.record);
  const lost = nudge.delivery !== "delivered";
  const reason = lost
    ? `its continue nudge of ${nudge.at} is not known to have arrived (${nudge.detail}); it is never nudged again, a person checks the session`
    : `still waiting on the wall it met at ${nudge.episode} after its one continue nudge of ${nudge.at}; it is never nudged again, a person checks the session`;
  return {
    stage: "notify",
    target,
    record: "runtime",
    reason,
    evidence: {
      record: r.record.id,
      stage: "steer",
      account: r.record.account,
      episode: nudge.episode,
    },
    cause: "nudge-unanswered",
    notice: pickupNotice(
      input.slug,
      `${target} ${lost ? "nudge not known to have arrived" : "still waiting after its nudge"}, record ${r.record.id}, episode ${nudge.episode}`,
      `${target}: the ${r.record.action} session ${reason}`,
    ),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/**
 * The nudges wanted for `repo`'s waiting sessions, the notifications a
 * nudge left unanswered, and a report line for a session that waits on a
 * wall still standing.
 */
export function planSteers(input: SteerInput): {
  actions: Action[];
  running: Running[];
} {
  const actions: Action[] = [];
  const running: Running[] = [];
  for (const r of input.launches) {
    const { record } = r;
    const nudgedLost = [...input.nudges.values()].find(
      (n) => n.record === record.id && n.delivery !== "delivered",
    );
    const waiting = waitingOn(r, input.sessions);
    if (nudgedLost !== undefined) {
      actions.push(
        unanswered(input, r, nudgedLost, record.workspace?.path ?? undefined),
      );
      continue;
    }
    if (waiting === null) continue;
    const { episode, agent, workspace } = waiting;
    const target = targetOf(record);
    const sent = input.nudges.get(nudgeKey(record.id, episode.observedAt));
    if (sent !== undefined) {
      actions.push(...unansweredWhileWaiting(input, r, sent, episode));
      continue;
    }
    const reset =
      episode.resetAt === null ? Number.NaN : Date.parse(episode.resetAt);
    if (!(reset <= input.nowMs)) {
      running.push({
        target,
        stage: "steer",
        reason: `waiting on its account's wall since ${episode.observedAt}, which resets ${episode.resetAt ?? "at an unknown time"}: no nudge before the reset`,
        evidence: { record: record.id, account: record.account },
      });
      continue;
    }
    if (!episode.last) {
      running.push({
        target,
        stage: "steer",
        reason: `waiting after its wall reset, and its last record is no longer the wall it met at ${episode.observedAt}: no nudge`,
        evidence: { record: record.id, account: record.account },
      });
      continue;
    }
    actions.push({
      stage: "steer",
      target,
      record: "runtime",
      reason: `waiting since its account's wall (met ${episode.observedAt}) reset at ${episode.resetAt}, its last record still that wall: send the continue nudge once`,
      evidence: {
        record: record.id,
        agent,
        workspace,
        account: record.account,
        wall: episode.evidence,
      },
      nudge: {
        record: record.id,
        agent,
        episode: episode.observedAt,
        account: record.account,
      },
    });
  }
  return { actions, running };
}

function outcome(
  action: Action,
  result: SteerOutcome["outcome"],
  detail: string,
): SteerOutcome {
  const nudge = action.nudge as NonNullable<Action["nudge"]>;
  return {
    target: action.target,
    record: nudge.record,
    episode: nudge.episode,
    outcome: result,
    detail,
  };
}

/** The runtime's answer; a call that throws is an answer lost. */
async function steerOnce(
  state: ApplyState,
  agent: string,
): Promise<RuntimeReceipt> {
  try {
    return await state.runtime.steer(agent, "continue");
  } catch (error) {
    return { ok: false, lost: true, detail: failureText(error) };
  }
}

/** One planned nudge: its pending record, the send, its delivery mark and event row. */
async function sendOne(
  state: ApplyState,
  repo: string,
  action: Action,
  root: string,
): Promise<SteerOutcome> {
  const nudge = action.nudge as NonNullable<Action["nudge"]>;
  const late = outOfTime(state);
  if (late !== null) return outcome(action, "refused", late);
  const record: NudgeRecord = {
    repo,
    record: nudge.record,
    target: action.target,
    account: nudge.account,
    episode: nudge.episode,
    at: new Date().toISOString(),
    delivery: "pending",
    detail: "",
  };
  const db = stateDb(root);
  const attempted = db
    .query(
      `INSERT INTO nudges (record, episode, repo, target, account, at, delivery, detail)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', '')
       ON CONFLICT (record, episode) DO NOTHING`,
    )
    .run(
      record.record,
      record.episode,
      record.repo,
      record.target,
      record.account,
      record.at,
    );
  if (attempted.changes !== 1)
    return outcome(
      action,
      "refused",
      "a nudge for this episode was already attempted",
    );
  const receipt = await steerOnce(state, nudge.agent);
  if (!receipt.ok && receipt.lost !== true) {
    // Nothing was typed: the episode may be nudged at a later tick.
    db.query(
      "DELETE FROM nudges WHERE record = ? AND episode = ? AND delivery = 'pending'",
    ).run(record.record, record.episode);
    return outcome(action, "refused", receipt.detail);
  }
  const delivery = receipt.ok ? "delivered" : "unknown";
  markDelivery(record, delivery, receipt.detail, root);
  return outcome(action, receipt.ok ? "sent" : "unknown", receipt.detail);
}

/** `--apply` for one repository's nudges, where the machine file enables `steer`. */
export async function applySteers(
  state: ApplyState,
  repo: string,
  report: RepoReport,
): Promise<void> {
  const root = state.root ?? stateRoot();
  const steers: SteerOutcome[] = [];
  for (const action of report.actions.filter((a) => a.stage === "steer"))
    steers.push(await sendOne(state, repo, action, root));
  report.steers = steers;
}
