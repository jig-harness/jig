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
}
export type AccountWeights = ReadonlyMap<string, AccountWeight>;

/** Report the original failure before reducing it to the account view's diagnostic. */
function weightsProblem({ document }: LocalWeights): string | null {
  if (document.ok) return null;
  log.debug(
    `account weights: ${document.failure.reason}`,
    failureFields(document.failure.cause),
  );
  return document.failure.reason;
}

/** A bad accounts section closes every account: no partially read file can resume a paused one. */
export function readAccountWeights(
  accounts: readonly MachineAccount[],
  reading = readLocalWeights(),
): AccountWeights {
  const { document, path } = reading;
  let problem = weightsProblem(reading);
  const section = document.ok ? document.value?.accounts : undefined;
  if (section !== undefined) {
    if (!isMapping(section)) problem = `${path}: accounts must be a mapping`;
    else
      for (const [name, value] of Object.entries(section)) {
        if (!accounts.some((a) => a.name === name))
          problem = `${path}: accounts names unknown account ${name}`;
        else if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 100
        )
          problem = `${path}: accounts.${name} must be a finite weight from 0 to 100`;
      }
  }
  return new Map<string, AccountWeight>(
    accounts.map((account) => {
      if (problem !== null)
        return [account.name, { configured: null, reason: problem }];
      const value = isMapping(section) ? section[account.name] : undefined;
      return [
        account.name,
        {
          configured: typeof value === "number" ? value : 100,
          reason:
            typeof value === "number"
              ? `${path}: accounts.${account.name}`
              : document.ok && document.value === null
                ? `default 100; ${path} absent`
                : `default 100; ${path} does not name this account`,
        },
      ];
    }),
  );
}
