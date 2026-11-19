/** The account weights a tick reports, including reasons an effective weight is zero. */
import {
  effectiveAccountWeight,
  hostCodexOptIn,
  notAdmitted,
  slotTable,
  type Slots,
  type CodexOptIn,
} from "./accounts.ts";
import { passTimeoutSeconds } from "../../skills/drive-pr/scripts/lib/driver/settings.ts";
import { driversOf, type HostDrivers } from "./host-drivers.ts";
import type { AccountWeights } from "./local-weights.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { ReadRecord } from "./launches.ts";

export interface AccountWeightReport {
  account: string;
  configured: number | null;
  effective: number;
  reason: string;
}

export function weightReport(
  slots: Slots,
  refusal: string | null = null,
): AccountWeightReport {
  const why =
    refusal ??
    (slots.wallUnrecorded
      ? "wall not recorded"
      : slots.wall !== null
        ? `walled until ${slots.wall.resetAt}`
        : slots.held >= slots.account.maxPerAccount
          ? "at safety ceiling"
          : null);
  return {
    account: slots.account.name,
    configured: slots.weight.configured,
    effective: effectiveAccountWeight(slots, refusal),
    reason:
      why === null ? slots.weight.reason : `${why}; ${slots.weight.reason}`,
  };
}

/** Every account is present even when there is no wanted work to launch. */
export function accountsReport(
  machine: MachineConfig | null,
  input: {
    records: ReadRecord[];
    nowMs: number;
    weights?: AccountWeights | undefined;
    drivers?: HostDrivers | undefined;
    table?: Slots[];
    passDeadlineSec?: number;
    codexOptIn?: CodexOptIn;
  },
) {
  if (machine === null) return {};
  const refused = notAdmitted(
    machine.accounts,
    input.passDeadlineSec ?? passTimeoutSeconds(),
    input.codexOptIn ?? hostCodexOptIn(),
  );
  return {
    ...(refused.length === 0 ? {} : { accountsNotAdmitted: refused }),
    accountWeights: (
      input.table ??
      slotTable(
        machine.accounts,
        input.records,
        input.nowMs,
        undefined,
        input.weights,
        driversOf(input.drivers),
      )
    ).map((slots) =>
      weightReport(
        slots,
        refused.find((entry) => entry.account === slots.account.name)?.reason ??
          null,
      ),
    ),
  };
}
