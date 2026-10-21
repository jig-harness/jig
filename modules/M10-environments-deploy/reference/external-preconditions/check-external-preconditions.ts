// Read-only registry check. Exit 0: pass/waived; 1: unresolved; 2: invalid input.
import { readFileSync } from "node:fs";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import { isRecord } from "../../../../plugin/shared/guards.ts";
import { branchProtection } from "./branch-protection.ts";
import {
  parseRegistry,
  runRegistry,
  PreconditionError,
  type EntryReport,
} from "./registry.ts";

export async function checkExternalPreconditions(
  args: string[],
): Promise<number> {
  const { values } = strictOptions(
    {
      args,
      options: {
        registry: { type: "string" },
        input: { type: "string" },
        now: { type: "string" },
        json: { type: "boolean" },
      },
    },
    "usage: check-external-preconditions.ts --registry FILE [--input JSON] [--now ISO] [--json]",
  );
  if (!values.registry) throw new PreconditionError("--registry is required");
  if (values.now && !values.input)
    throw new PreconditionError("--now is available only with offline --input");
  const input = fixtureInput(values.input);
  const now = observationTime(values.now);
  const report = await runRegistry(
    parseRegistry(readFileSync(values.registry, "utf8")),
    {
      checks: { "branch-protection": branchProtection() },
      ...(input ? { input } : {}),
      ...(now !== undefined ? { now } : {}),
    },
  );
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else for (const entry of report.entries) console.log(renderEntry(entry));
  return report.status === "pass" ? 0 : 1;
}

function fixtureInput(
  path: string | undefined,
): Record<string, unknown> | undefined {
  if (!path) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed))
    throw new PreconditionError(
      "fixture JSON must map precondition ids to observations",
    );
  return parsed;
}
function observationTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const now = Date.parse(value);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== value)
    throw new PreconditionError(
      "--now must be a canonical ISO UTC timestamp, including milliseconds",
    );
  return now;
}
function renderEntry(entry: EntryReport): string {
  const waiver = entry.waiver
    ? `\n  Waiver: ${entry.waiver.reason}; approved by ${entry.waiver.approved_by}; expires ${entry.waiver.expires}T00:00:00Z`
    : "";
  return `${entry.outcome.toUpperCase()} ${entry.id} (owner: ${entry.owner}; observed: ${entry.status})\n${entry.reasons.map((reason) => `  ${reason}`).join("\n")}\n  Remediation: ${entry.remediation}${waiver}`;
}
if (import.meta.main)
  cli(() => checkExternalPreconditions(process.argv.slice(2)));
