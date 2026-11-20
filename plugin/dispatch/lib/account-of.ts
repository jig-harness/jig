/** Which listed account a launch record bills. */
import type { MachineAccount } from "./machine-config.ts";

/**
 * The listed account a record bills. An account is its vendor and
 * configuration directory; its name is a label a person may change. So the
 * account at the record's vendor and directory is the one, whatever it is
 * called now, and the name decides only when no listed account has them.
 */
export function accountOf(
  accounts: readonly MachineAccount[],
  record: { account: string; vendor: string; configDir: string },
): string | null {
  const same = accounts.filter(
    (a) => a.vendor === record.vendor && a.configDir === record.configDir,
  );
  if (same.length === 1) return (same[0] as MachineAccount).name;
  if (same.length > 1) return null;
  return accounts.find((a) => a.name === record.account)?.name ?? null;
}
