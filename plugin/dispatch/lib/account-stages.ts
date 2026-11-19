/**
 * The stages in the machine file: the ones a repository's entry enables
 * (`repositories[].stages`), and the launching stages an account serves
 * (`accounts[].stages`).
 *
 * An account with no `stages` serves every stage that launches a session.
 * One that lists them is passed over, before weights, turns, walls and slots
 * are weighed, for an action of any other stage: a re-arm, a takeover and a
 * re-drive (a conflict re-drive among them) are the `rearm` stage's.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

/** The stages a machine file can enable. */
export const MACHINE_STAGES = [
  "rearm",
  "pickup",
  "followup",
  "notify",
  "steer",
  "steward",
] as const;
export type MachineStage = (typeof MACHINE_STAGES)[number];

/** The stages that launch a session on an account. */
export const SERVED_STAGES = [
  "pickup",
  "rearm",
  "followup",
  "steward",
] as const;
export type ServedStage = (typeof SERVED_STAGES)[number];

/** The machine file's stages that start no session, so no account serves them. */
const SESSIONLESS: readonly string[] = MACHINE_STAGES.filter(
  (s) => !(SERVED_STAGES as readonly string[]).includes(s),
);

type Checked<T> = Outcome<T, "invalid">;

function invalid(reason: string): Checked<never> {
  return failed("invalid", reason);
}

/** A repository's stages: a list, possibly empty, of distinct machine stages. */
export function machineStages(
  value: unknown,
  where: string,
): Checked<MachineStage[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return invalid(`${where} must be a list`);
  if (
    value.some((s) => !(MACHINE_STAGES as readonly unknown[]).includes(s)) ||
    new Set(value).size !== value.length
  )
    return invalid(
      `${where} must list distinct stages from ${MACHINE_STAGES.join(", ")}`,
    );
  return ok(value as MachineStage[]);
}

/**
 * An account's stages: `undefined` when left out (every launching stage),
 * else a nonempty list of distinct launching stages. `where` names the
 * account in the reason.
 */
export function accountStages(
  value: unknown,
  where: string,
): Checked<ServedStage[] | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  const known = SERVED_STAGES.join(", ");
  if (!Array.isArray(value))
    return invalid(`${where} must be a list of stages from ${known}`);
  if (value.length === 0)
    return invalid(
      `${where} is empty: list the stages the account serves from ${known}, or leave it out to serve every one`,
    );
  const seen = new Set<unknown>();
  for (const stage of value) {
    if (SESSIONLESS.includes(stage as string))
      return invalid(
        `${where} names ${stage}, a stage that launches no session: an account serves ${known}`,
      );
    if (!(SERVED_STAGES as readonly unknown[]).includes(stage))
      return invalid(
        `${where} names an unknown stage ${String(stage)}: an account serves ${known}`,
      );
    if (seen.has(stage)) return invalid(`${where} lists ${stage} twice`);
    seen.add(stage);
  }
  return ok(value as ServedStage[]);
}

/** Whether an account serves `stage`: every account serves every stage its file does not narrow. */
export function serves(
  account: { stages?: readonly ServedStage[] | undefined },
  stage: string,
): boolean {
  return (
    account.stages === undefined ||
    (account.stages as readonly string[]).includes(stage)
  );
}

/**
 * The accounts that serve each launching stage, by name, when the file
 * narrows any account's stages; `undefined` when every account serves every
 * stage.
 */
export function stageAccounts(
  accounts: ReadonlyArray<{
    name: string;
    stages?: readonly ServedStage[] | undefined;
  }>,
): Record<ServedStage, string[]> | undefined {
  if (accounts.every((a) => a.stages === undefined)) return undefined;
  const out = {} as Record<ServedStage, string[]>;
  for (const stage of SERVED_STAGES)
    out[stage] = accounts.filter((a) => serves(a, stage)).map((a) => a.name);
  return out;
}
