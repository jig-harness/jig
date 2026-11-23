/** The fields every kind of machine-file account has: its name, its slots and the stages it serves. */
import { ok } from "../../shared/outcome.ts";
import { accountStages, type ServedStage } from "./account-stages.ts";
import { type Checked, count, invalid, text } from "./machine-values.ts";

/** `accounts[i].name`: letters, digits, dot, dash or underscore. */
export function accountName(value: unknown, where: string): Checked<string> {
  const name = text(value, `${where}.name`);
  if (!name.ok) return name;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name.value)
    ? name
    : invalid(
        `${where}.name must be letters, digits, dot, dash or underscore: ${name.value}`,
      );
}

/** An account's `max_per_account` (default `maxPerAccount`) and `stages`, the account `name` named in a stage's reason. */
export function slotsAndStages(
  value: Record<string, unknown>,
  where: string,
  name: string,
  maxPerAccount: number,
): Checked<{ maxPerAccount: number; stages?: ServedStage[] }> {
  const slots = count(
    value.max_per_account,
    `${where}.max_per_account`,
    maxPerAccount,
  );
  if (!slots.ok) return slots;
  const served = accountStages(value.stages, `${where}.stages (${name})`);
  if (!served.ok) return served;
  return ok({
    maxPerAccount: slots.value,
    ...(served.value === undefined ? {} : { stages: served.value }),
  });
}
