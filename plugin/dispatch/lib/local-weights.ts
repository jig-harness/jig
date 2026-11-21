/** Host-local launch preferences. Each consumer validates only its own section. */
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { isMapping, jigHome } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { failureFields } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";
import { load } from "../../shared/yaml.ts";
import type { MachineAccount } from "./machine-config.ts";

export interface LocalWeights {
  path: string;
  document: Outcome<Record<string, unknown> | null, "weights-unreadable">;
}

/** Absence is the default; a file that exists but cannot be read never means absence. */
export function readLocalWeights(
  path = join(jigHome(), "weights.local.yaml"),
): LocalWeights {
  try {
    const value = load(readFileSync(path, "utf8"));
    const unknown = isMapping(value)
      ? Object.keys(value).find((key) => key !== "accounts" && key !== "lanes")
      : undefined;
    return {
      path,
      document:
        unknown !== undefined
          ? failed("weights-unreadable", `${path}: unknown section ${unknown}`)
          : isMapping(value)
            ? ok(value)
            : failed(
                "weights-unreadable",
                `${path}: expected a mapping with accounts and/or lanes`,
              ),
    };
  } catch (error) {
    let absent = false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        lstatSync(path);
      } catch (statError) {
        absent = (statError as NodeJS.ErrnoException).code === "ENOENT";
      }
    }
    return {
      path,
      document: absent
        ? ok(null)
        : failed(
            "weights-unreadable",
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
    };
  }
}

export interface AccountWeight {
  /** Null means the accounts section could not be trusted, so admission closes. */
  configured: number | null;
  reason: string;
  /** The names in the accounts section the machine file does not list, skipped, and the file's path; absent when there are none. */
  skipped?: SkippedNames;
}
export type AccountWeights = ReadonlyMap<string, AccountWeight>;

/** Account names a weights file names that the machine file does not list, sorted. */
export interface SkippedNames {
  names: readonly string[];
  path: string;
}

/** Report the original failure before reducing it to the account view's diagnostic. */
function weightsProblem({ document }: LocalWeights): string | null {
  if (document.ok) return null;
  log.debug(
    `account weights: ${document.failure.reason}`,
    failureFields(document.failure.cause),
  );
  return document.failure.reason;
}

/** Whether `value` is a weight an account may carry. */
function isWeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

/** The accounts section's fault, if any, and the names it carries that the machine file does not list, sorted. */
function checkSection(
  section: unknown,
  accounts: readonly MachineAccount[],
  path: string,
): { problem: string | null; skipped: string[] } {
  if (section === undefined) return { problem: null, skipped: [] };
  if (!isMapping(section))
    return { problem: `${path}: accounts must be a mapping`, skipped: [] };
  let problem: string | null = null;
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(section))
    if (!accounts.some((a) => a.name === name)) skipped.push(name);
    else if (!isWeight(value))
      problem = `${path}: accounts.${name} must be a finite weight from 0 to 100`;
  return { problem, skipped: skipped.sort() };
}

/** Why an account the section gives no weight has weight 100. */
function defaultReason({ document, path }: LocalWeights): string {
  return document.ok && document.value === null
    ? `default 100; ${path} absent`
    : `default 100; ${path} does not name this account`;
}

/** What every account's reason adds for the skipped names. */
function skipNote(skipped: readonly string[], path: string): string {
  if (skipped.length === 0) return "";
  const which =
    skipped.length === 1 ? "an unknown account" : "unknown accounts";
  return `; skipped ${which} ${skipped.join(", ")} in ${path}`;
}

/**
 * A bad accounts section closes every account: no partially read file can
 * resume a paused one. A name the machine file does not list gives no
 * account a weight, so it is skipped, and every account's reason names it.
 */
export function readAccountWeights(
  accounts: readonly MachineAccount[],
  reading = readLocalWeights(),
): AccountWeights {
  const { document, path } = reading;
  const section = document.ok ? document.value?.accounts : undefined;
  const checked = checkSection(section, accounts, path);
  const problem = weightsProblem(reading) ?? checked.problem;
  const { skipped } = checked;
  const note = skipNote(skipped, path);
  const skip =
    skipped.length === 0 ? {} : { skipped: { names: skipped, path } };
  return new Map<string, AccountWeight>(
    accounts.map((account): [string, AccountWeight] => {
      if (problem !== null)
        return [account.name, { configured: null, reason: problem }];
      const value = isMapping(section) ? section[account.name] : undefined;
      return [
        account.name,
        typeof value === "number"
          ? {
              configured: value,
              reason: `${path}: accounts.${account.name}${note}`,
              ...skip,
            }
          : {
              configured: 100,
              reason: `${defaultReason(reading)}${note}`,
              ...skip,
            },
      ];
    }),
  );
}

/** The names the weights file's accounts section names that the machine file does not list; `null` when there are none. */
export function skippedAccountNames(
  weights: AccountWeights | undefined,
): SkippedNames | null {
  for (const weight of weights?.values() ?? []) return weight.skipped ?? null;
  return null;
}
