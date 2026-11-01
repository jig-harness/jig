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
 *   the session and its episode is written, pending, under
 *   `~/.local/state/jig/dispatch/nudges/`; its delivery is a second mark
 *   written after (delivered, or not known to have arrived). A send whose
 *   answer is lost, or a tick that stopped between the two, never leads to
 *   a second one: a pending record a later tick finds is marked not known
 *   to have arrived. A check that failed before any send removes the
 *   pending record, since nothing was typed.
 * - **Then a person.** A nudge not known to have arrived, or a session
 *   still waiting on the same episode after its nudge, is notified; it is
 *   never nudged again.
 * - **Logged.** Each nudge's event row is written with its delivery mark,
 *   so the log never reads an attempted nudge as a delivered one.
 *
 * There is no open-ended nudge: every other stuck state is a notification.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../shared/errors.ts";
import { isRecord } from "../../../shared/guards.ts";
import { publishOnce, stateRoot } from "../../receipts.ts";
import {
  isInteractive,
  type ReadRecord,
  targetOf,
  type WaitingEpisode,
} from "../launches.ts";
import { appendRow } from "../log.ts";
import { pickupNotice } from "../notices.ts";
import {
  type RuntimeReceipt,
  type SessionsReport,
  WAITING_STATES,
} from "../runtime/port.ts";
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

function nudgesRoot(root: string): string {
  return join(root, "nudges");
}

function digest(record: string, episode: string): string {
  return createHash("sha256")
    .update(`${record}\n${episode}`)
    .digest("hex")
    .slice(0, 32);
}

function attemptFile(root: string, record: string, episode: string): string {
  return join(nudgesRoot(root), `${digest(record, episode)}.json`);
}

function deliveryFile(root: string, record: string, episode: string): string {
  return join(nudgesRoot(root), `${digest(record, episode)}.delivery`);
}

/** The mark that a nudge's event row is in the log: a later tick does not look for it again. */
function loggedFile(root: string, record: string, episode: string): string {
  return join(nudgesRoot(root), `${digest(record, episode)}.logged`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    swallow(error, `${path} does not read`);
    return undefined;
  }
}

/** The nudges of `repo`, by record and episode. */
export function readNudges(
  repo: string,
  root = stateRoot(),
): Map<string, NudgeRecord> {
  const out = new Map<string, NudgeRecord>();
  let names: string[];
  try {
    names = readdirSync(nudgesRoot(root));
  } catch (error) {
    swallow(error, "no nudge has been sent yet");
    return out;
  }
  for (const name of names.filter((n) => /^[a-f\d]{32}\.json$/.test(n))) {
    const value = readJson(join(nudgesRoot(root), name));
    if (
      !isRecord(value) ||
      value.repo !== repo ||
      typeof value.record !== "string" ||
      typeof value.episode !== "string"
    )
      continue;
    const mark = readJson(
      join(nudgesRoot(root), name.replace(/\.json$/, ".delivery")),
    );
    const delivery =
      isRecord(mark) &&
      (mark.delivery === "delivered" || mark.delivery === "unknown")
        ? mark.delivery
        : "pending";
    out.set(nudgeKey(value.record, value.episode), {
      ...(value as unknown as NudgeRecord),
      delivery,
      detail:
        isRecord(mark) && typeof mark.detail === "string" ? mark.detail : "",
    });
  }
  return out;
}

function nudgeKey(record: string, episode: string): string {
  return `${record} ${episode}`;
}

/** Append a nudge's event row, then its logged mark; the row's key makes a repeat a no-op. */
function logDelivery(
  nudge: NudgeRecord,
  delivery: "delivered" | "unknown",
  detail: string,
  root: string,
): void {
  appendRow(
    {
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
    },
    root,
  );
  publishOnce(loggedFile(root, nudge.record, nudge.episode), `${nudge.at}\n`);
}

/** Write a nudge's delivery mark, and its event row with it. */
function markDelivery(
  nudge: NudgeRecord,
  delivery: "delivered" | "unknown",
  detail: string,
  root: string,
): void {
  publishOnce(
    deliveryFile(root, nudge.record, nudge.episode),
    `${JSON.stringify({ delivery, detail, at: new Date().toISOString() })}\n`,
  );
  logDelivery(nudge, delivery, detail, root);
}

/**
 * Mark each nudge of `repo` still pending (a tick stopped between the send
 * and its mark) as not known to have arrived, with its event row; a nudge
 * already marked gets its event row again when a stop kept it from the log.
 */
export function settlePending(
  nudges: Map<string, NudgeRecord>,
  root = stateRoot(),
): void {
  for (const nudge of nudges.values()) {
    if (nudge.delivery !== "pending") {
      if (existsSync(loggedFile(root, nudge.record, nudge.episode))) continue;
      try {
        logDelivery(nudge, nudge.delivery, nudge.detail, root);
      } catch (error) {
        swallow(error, `the event row of the nudge of ${nudge.record} waits`);
      }
      continue;
    }
    const detail = "a later tick found the send without its answer";
    try {
      markDelivery(nudge, "unknown", detail, root);
      nudge.delivery = "unknown";
      nudge.detail = detail;
    } catch (error) {
      swallow(error, `the nudge of ${nudge.record} stays pending`);
    }
  }
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
    const reset = episode.resetAt === null ? NaN : Date.parse(episode.resetAt);
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
  mkdirSync(nudgesRoot(root), { recursive: true, mode: 0o700 });
  const attempt = attemptFile(root, nudge.record, nudge.episode);
  if (!publishOnce(attempt, `${JSON.stringify(record, null, 2)}\n`))
    return outcome(
      action,
      "refused",
      "a nudge for this episode was already attempted",
    );
  const receipt = await steerOnce(state, nudge.agent);
  if (!receipt.ok && receipt.lost !== true) {
    // Nothing was typed: the episode may be nudged at a later tick.
    rmSync(attempt, { force: true });
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
