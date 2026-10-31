/**
 * `--apply` for drives: start each re-arm and takeover the plan wants, in
 * order, as a headless pass in the pull request's workspace, on an
 * admitted account. For each one:
 *
 * 1. read the pull request's ledger again, and go on only when its facts
 *    are the ones the plan acted on;
 * 2. admit an account (accounts.ts), and check that the wrapper's
 *    environment resolves to that account's identity;
 * 3. use the workspace that holds the pull request, or open one;
 * 4. write the launch record, then call the runtime's `launch` under the
 *    record's token.
 *
 * Before any of that, a pending record of the repository whose launch got
 * no answer is retried once, under its own record and token, never as a
 * fresh launch. Everything else in the plan is reported, as without
 * `--apply`.
 */
import type { MachineConfig } from "../machine-config.ts";
import {
  type IdentityCheck,
  admitRearm,
  admitTakeover,
  checkIdentity,
  type Slots,
} from "../accounts.ts";
import {
  holds,
  type LaunchAttempt,
  type LaunchRecord,
  newRecordId,
  newToken,
  type ReadRecord,
  removeRecord,
  writeRecord,
} from "../launches.ts";
import type {
  SessionRuntime,
  SessionsReport,
  RuntimeReceipt,
} from "../runtime/port.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  DrivenPr,
  LaunchOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import { factsOf } from "./drive-hold.ts";

/** What `--apply` carries across a tick's repositories. */
export interface ApplyState {
  machine: MachineConfig;
  runtime: SessionRuntime;
  /** Every launch record, the ones this tick writes appended. */
  records: ReadRecord[];
  table: Slots[];
  /** The account of the most recent launch record, where the turn resumes. */
  last: string | null;
  identities: Map<string, IdentityCheck>;
  root?: string;
}

/** A pending record's launch is retried once, under its own key. */
const MAX_ATTEMPTS = 2;

function attemptOf(receipt: RuntimeReceipt): LaunchAttempt {
  return {
    at: new Date().toISOString(),
    outcome: receipt.ok ? "sent" : receipt.lost ? "lost" : "failed",
    detail: receipt.detail,
  };
}

async function callLaunch(
  state: ApplyState,
  record: LaunchRecord,
): Promise<LaunchAttempt> {
  const workspace = record.workspace as { id: string; path: string };
  let receipt: RuntimeReceipt;
  try {
    receipt = await state.runtime.launch(
      workspace,
      { kind: "headless", title: `drive #${record.pr}`, record: record.id },
      record.account,
      record.token,
    );
  } catch (error) {
    receipt = { ok: false, lost: true, detail: failureText(error) };
  }
  const attempt = attemptOf(receipt);
  record.attempts.push(attempt);
  writeRecord(record, state.root);
  return attempt;
}

/** Whether a takeover shares the slot of the record it replaces, which still holds it. */
function sharesSlot(state: ApplyState, record: LaunchRecord): boolean {
  const replaced = state.records.find((r) => r.record.id === record.replaces);
  return replaced !== undefined && holds(replaced.state);
}

/** Release the slot of a record the runtime answered it started nothing for. */
function release(state: ApplyState, record: LaunchRecord): void {
  removeRecord(record.id, state.root);
  state.records = state.records.filter((r) => r.record.id !== record.id);
  const slots = state.table.find((s) => s.account.name === record.account);
  if (slots !== undefined && !sharesSlot(state, record)) slots.held -= 1;
}

function outcome(
  record: LaunchRecord,
  attempt: LaunchAttempt,
  retried: boolean,
): LaunchOutcome {
  return {
    target: `PR #${record.pr}`,
    action: record.action,
    outcome:
      attempt.outcome === "sent"
        ? retried
          ? "retried"
          : "launched"
        : attempt.outcome,
    account: record.account,
    record: record.id,
    detail: attempt.detail,
  };
}

/** Retry, once and under its own key, each pending record of `repo` whose launch got no answer. */
async function retryPending(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
): Promise<void> {
  for (const { record, state: s } of [...state.records]) {
    if (record.repo !== repo.slug || s.kind !== "pending") continue;
    const last = record.attempts.at(-1);
    if (last?.outcome === "sent" || record.attempts.length >= MAX_ATTEMPTS)
      continue;
    if (record.workspace === null) continue;
    const attempt = await callLaunch(state, record);
    if (attempt.outcome === "failed") release(state, record);
    report.launches.push(outcome(record, attempt, true));
  }
}

function waits(
  action: Action,
  detail: string,
  account: string | null = null,
): LaunchOutcome {
  return {
    target: action.target,
    action: action.takeover === undefined ? "rearm" : "takeover",
    outcome: "waits",
    account,
    record: null,
    detail,
  };
}

function refused(
  action: Action,
  detail: string,
  account: string | null,
): LaunchOutcome {
  return { ...waits(action, detail, account), outcome: "refused" };
}

/** The fresh read: the ledger must still say what the plan acted on. */
function stillWanted(action: Action, fresh: DrivenPr | null): string | null {
  if (fresh === null) return "its ledger cannot be read again";
  if (factsOf(fresh) !== action.facts)
    return `its ledger changed since the plan read it (now ${factsOf(fresh)})`;
  const want = action.takeover === undefined ? "re-armable" : "silent";
  return fresh.class === want
    ? null
    : `its ledger now reads ${fresh.class}: ${fresh.why}`;
}

async function identityOf(
  state: ApplyState,
  slots: Slots,
): Promise<IdentityCheck> {
  const cached = state.identities.get(slots.account.name);
  if (cached !== undefined) return cached;
  const check = await checkIdentity(
    slots.account,
    Math.ceil(state.machine.runtimeTimeoutMs / 1000),
  );
  state.identities.set(slots.account.name, check);
  return check;
}

async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  pr: number,
  head: string,
  sessions: SessionsReport,
): Promise<{ id: string; path: string } | string> {
  const held = sessions.ok
    ? sessions.workspaces.find((w) => w.prs.includes(pr))
    : undefined;
  if (held !== undefined) return { id: held.id, path: held.path };
  let opened: RuntimeReceipt;
  try {
    opened = await state.runtime.openWorkspace(repo, { pr, head });
  } catch (error) {
    return `the workspace could not be opened: ${failureText(error)}`;
  }
  if (opened.ok && opened.workspace !== undefined) return opened.workspace;
  return `the workspace could not be opened${opened.lost ? " in time" : ""}: ${opened.detail}`;
}

function admission(state: ApplyState, action: Action) {
  if (action.takeover === undefined) return admitRearm(state.table, state.last);
  const replaced = state.records.find((r) => r.record.id === action.takeover);
  return replaced === undefined
    ? { waits: `the launch record ${action.takeover} it replaces is gone` }
    : admitTakeover(state.table, replaced);
}

/** One planned re-arm or takeover, through its fresh read, admission, workspace and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  fresh: DrivenPr | null,
  sessions: SessionsReport,
): Promise<LaunchOutcome> {
  const changed = stillWanted(action, fresh);
  if (changed !== null) return waits(action, changed);
  const admitted = admission(state, action);
  if ("waits" in admitted) return waits(action, admitted.waits);
  const slots = admitted.admitted;
  const identity = await identityOf(state, slots);
  if (!identity.ok)
    return refused(
      action,
      `identity check: ${identity.reason}`,
      slots.account.name,
    );
  const pr = fresh as DrivenPr;
  const workspace = await workspaceFor(
    state,
    repo,
    pr.number,
    pr.head,
    sessions,
  );
  if (typeof workspace === "string")
    return refused(action, workspace, slots.account.name);
  const record: LaunchRecord = {
    version: 1,
    id: newRecordId(new Date()),
    token: newToken(),
    action: action.takeover === undefined ? "rearm" : "takeover",
    repo: repo.slug,
    repoPath: repo.path,
    pr: pr.number,
    account: slots.account.name,
    vendor: slots.account.vendor,
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    replaces: action.takeover ?? null,
    facts: action.facts ?? factsOf(pr),
    createdAt: new Date().toISOString(),
    workspace,
    attempts: [],
  };
  writeRecord(record, state.root);
  if (!sharesSlot(state, record)) slots.held += 1;
  state.records.push({ record, state: { kind: "pending" } });
  state.last = slots.account.name;
  const attempt = await callLaunch(state, record);
  if (attempt.outcome === "failed") release(state, record);
  return outcome(record, attempt, false);
}

/** `--apply` for one repository's drives; `fresh` re-reads one pull request's ledger. */
export async function applyDrives(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  fresh: (pr: number) => Promise<DrivenPr | null>,
): Promise<void> {
  await retryPending(state, repo, report);
  for (const action of report.actions) {
    if (action.stage !== "rearm") continue;
    const pr = Number(action.target.replace(/^PR #/, ""));
    let read: DrivenPr | null;
    try {
      read = await fresh(pr);
    } catch (error) {
      report.launches.push(
        waits(action, `its ledger cannot be read again: ${failureText(error)}`),
      );
      continue;
    }
    report.launches.push(await launchOne(state, repo, action, read, sessions));
  }
}
