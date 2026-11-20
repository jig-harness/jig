/**
 * Which account an action is admitted on, by its stage: a pickup and a
 * steward pass under the pickup deadline, a re-arm, a re-drive and a
 * follow-up under the pass deadline, each among the accounts that serve its
 * stage (`accounts[].stages`); a takeover in the slot of the record it
 * replaces while that record's account serves the stage, and otherwise as a
 * new launch of the stage would be.
 */
import {
  type Admission,
  admitRearm,
  admitHostDriverTakeover,
  admitTakeover,
  type CodexOptIn,
  type Slots,
  slotsOf,
} from "../accounts.ts";
import { unrecordedDrivers, type HostDrivers } from "../host-drivers.ts";
import { serves, type ServedStage } from "../account-stages.ts";
import type { ReadRecord } from "../launches.ts";
import type { Action } from "../types.ts";

/** What admission reads of a tick's state. */
export interface AdmissionState {
  table: Slots[];
  last: string | null;
  records: ReadRecord[];
  codexOptIn: CodexOptIn;
  passDeadlineSec: number;
  drivers?: HostDrivers;
}

/**
 * Whether a takeover runs as a new launch of its stage rather than in the
 * replaced record's slot: that record's account is listed and does not serve
 * the stage. Such a takeover may try the next account after an identity
 * check fails, as a re-arm does.
 */
export function takeoverMoves(state: AdmissionState, action: Action): boolean {
  if (action.takeover === undefined) return false;
  const replaced = state.records.find((r) => r.record.id === action.takeover);
  if (replaced === undefined) return false;
  const own = slotsOf(state.table, replaced.record);
  return own !== undefined && !serves(own.account, action.stage);
}

export function admission(
  state: AdmissionState,
  action: Action,
  excluded: ReadonlySet<string>,
  pickupDeadlineSec: number,
  clone?: string | null,
): Admission {
  const codex = state.codexOptIn;
  const stage = action.stage as ServedStage;
  if (
    action.takeoverHolder !== undefined &&
    state.drivers?.ok &&
    clone !== null &&
    clone !== undefined
  ) {
    const holder = unrecordedDrivers(
      state.table.map((slots) => slots.account),
      state.records,
      state.drivers.value,
    ).find(
      (driver) =>
        driver.driver.pr === Number(action.target.replace("PR #", "")) &&
        driver.driver.clone === clone,
    );
    if (
      holder?.account !== null &&
      holder?.account !== undefined &&
      !excluded.has(holder.account) &&
      (() => {
        const account = state.table.find(
          (slots) => slots.account.name === holder.account,
        )?.account;
        return account !== undefined && serves(account, stage);
      })()
    )
      return admitHostDriverTakeover(
        state.table,
        holder.account,
        state.passDeadlineSec,
        codex,
        stage,
      );
  }
  // A pickup is a headless pass under its own deadline (`dispatch.pickup_deadline`).
  if (stage === "pickup" || stage === "steward")
    return admitRearm(
      state.table,
      state.last,
      { kind: "pass", deadlineSec: pickupDeadlineSec, codex, stage },
      excluded,
      state.records,
    );
  // A follow-up is a headless pass, admitted as a drive's pass is: under the pass deadline it runs under.
  if (action.takeover === undefined || takeoverMoves(state, action))
    return admitRearm(
      state.table,
      state.last,
      { kind: "pass", deadlineSec: state.passDeadlineSec, codex, stage },
      excluded,
      state.records,
    );
  const replaced = state.records.find((r) => r.record.id === action.takeover);
  return replaced === undefined
    ? { waits: `the launch record ${action.takeover} it replaces is gone` }
    : admitTakeover(state.table, replaced, state.passDeadlineSec, codex);
}
