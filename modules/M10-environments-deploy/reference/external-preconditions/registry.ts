/** Declarative external requirements; checks only observe, never repair settings. */
import { load } from "../../../../lib/vendor/js-yaml.mjs";
import { isRecord } from "../../../../plugin/shared/guards.ts";

export class PreconditionError extends Error {}

export type Status = "pass" | "fail" | "unknown";
export interface Observation {
  status: Status;
  reasons: string[];
}
export interface Precondition {
  id: string;
  kind: string;
  owner: string;
  description?: string;
  target: Record<string, unknown>;
  expected: Record<string, unknown>;
  remediation: string;
  state: "active" | "pending";
  waiver?: { reason: string; approved_by: string; expires: string };
}
export interface Registry {
  version: 1;
  preconditions: Precondition[];
}
export type Check = (
  entry: Precondition,
  input: unknown,
) => Observation | Promise<Observation>;
export interface EntryReport extends Observation {
  id: string;
  kind: string;
  owner: string;
  remediation: string;
  outcome: Status | "pending" | "waived";
  waiver?: Precondition["waiver"];
}
export interface Report {
  status: "pass" | "fail";
  entries: EntryReport[];
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new PreconditionError(`${label} must be nonempty text`);
}
/** UTC calendar date, including round-trip validation (Date.parse alone rolls February over). */
export function expiry(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new PreconditionError(
      "waiver expires must be a quoted YYYY-MM-DD UTC date",
    );
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  )
    throw new PreconditionError("waiver expires must be a valid calendar date");
  return timestamp;
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new PreconditionError(`${label}: unknown field ${key}`);
}
export function parseRegistry(raw: string): Registry {
  const value: unknown = load(raw);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.preconditions) ||
    !value.preconditions.length
  )
    throw new PreconditionError(
      "registry needs version: 1 and nonempty preconditions",
    );
  keys(value, ["version", "preconditions"], "registry");
  const seen = new Set<string>();
  const preconditions = value.preconditions.map(
    (entry: unknown): Precondition => {
      if (!isRecord(entry))
        throw new PreconditionError("precondition must be an object");
      keys(
        entry,
        [
          "id",
          "kind",
          "owner",
          "description",
          "target",
          "expected",
          "remediation",
          "state",
          "waiver",
        ],
        "precondition",
      );
      for (const key of ["id", "kind", "owner", "remediation"])
        text(entry[key], key);
      const id = entry.id as string;
      if (seen.has(id))
        throw new PreconditionError(`duplicate precondition id: ${id}`);
      seen.add(id);
      if (entry.description !== undefined)
        text(entry.description, "description");
      if (!isRecord(entry.target) || !isRecord(entry.expected))
        throw new PreconditionError(
          `${id}: target and expected must be objects`,
        );
      if (entry.state !== "active" && entry.state !== "pending")
        throw new PreconditionError(`${id}: state must be active or pending`);
      validateWaiver(entry.waiver);
      return entry as unknown as Precondition;
    },
  );
  return { version: 1, preconditions };
}

function validateWaiver(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new PreconditionError("waiver must be an object");
  keys(value, ["reason", "approved_by", "expires"], "waiver");
  text(value.reason, "waiver reason");
  text(value.approved_by, "waiver approved_by");
  expiry(value.expires);
}
interface RunOptions {
  checks: Record<string, Check>;
  input?: Record<string, unknown>;
  now?: number;
}
function validateObservation(observation: Observation): void {
  if (
    !["pass", "fail", "unknown"].includes(observation.status) ||
    !Array.isArray(observation.reasons) ||
    !observation.reasons.every((r) => typeof r === "string")
  )
    throw new PreconditionError("check returned an invalid observation");
}
async function observe(
  entry: Precondition,
  options: RunOptions,
): Promise<Observation> {
  try {
    const check = Object.hasOwn(options.checks, entry.kind)
      ? options.checks[entry.kind]
      : undefined;
    if (!check)
      throw new PreconditionError(`unknown check kind: ${entry.kind}`);
    if (options.input && !Object.hasOwn(options.input, entry.id))
      throw new PreconditionError(
        `missing fixture for ${entry.id}; live access is disabled in fixture mode`,
      );
    const observation = await check(entry, options.input?.[entry.id]);
    validateObservation(observation);
    return observation;
  } catch (error) {
    return { status: "unknown", reasons: [String(error)] };
  }
}
function outcomeOf(
  entry: Precondition,
  observation: Observation,
  now: number,
): EntryReport["outcome"] {
  if (entry.waiver && expiry(entry.waiver.expires) <= now) {
    observation.reasons.push(
      `waiver expired at ${entry.waiver.expires}T00:00:00Z`,
    );
    return "fail";
  }
  if (entry.state === "pending") return "pending";
  if (entry.waiver && observation.status === "fail") return "waived";
  return observation.status;
}
/** A pending item is always non-green, even if a waiver was attached. */
export async function runRegistry(
  registry: Registry,
  options: RunOptions,
): Promise<Report> {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now))
    throw new PreconditionError("invalid observation time");
  const entries: EntryReport[] = [];
  for (const entry of registry.preconditions) {
    const observation = await observe(entry, options);
    entries.push({
      ...observation,
      id: entry.id,
      kind: entry.kind,
      owner: entry.owner,
      remediation: entry.remediation,
      outcome: outcomeOf(entry, observation, now),
      ...(entry.waiver ? { waiver: entry.waiver } : {}),
    });
  }
  return {
    status: entries.every((e) => e.outcome === "pass" || e.outcome === "waived")
      ? "pass"
      : "fail",
    entries,
  };
}
