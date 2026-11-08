import { randomUUID } from "node:crypto";
import { openReceipt, writeReceipt } from "./receipts.ts";
import { type Failure, failed, type Outcome } from "../shared/outcome.ts";
import { isMapping } from "../shared/config-layers.ts";
import { failureExit } from "../shared/cli.ts";
import { failureFields } from "../shared/errors.ts";
import { log } from "../shared/log.ts";
import { scheduledUpgradeOf, upgradeLine } from "../runtime/upgrade-record.ts";
import type {
  CollectionKind,
  Proof,
  Receipt,
  ReceiptLine,
  Resource,
} from "./types.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** What a boundary records of what it caught: its message in the receipt, and its stack and causes on the error log, since a throw here is a defect (ADR-0012). */
function caught(error: unknown): string {
  log.error("gc caught a failure at its boundary", failureFields(error));
  return message(error);
}
function outcome(proof: Proof): ReceiptLine["outcome"] {
  if (proof.state === "dead") return "would-collect";
  return proof.state === "live" ? "refused" : proof.state;
}
/** The proof gc relies on is conservative when the kind's proof throws; `thrown` marks that the run must still end nonzero. */
async function prove(
  kind: CollectionKind,
  resource: Resource,
): Promise<Proof & { thrown?: true }> {
  try {
    return await kind.prove(resource);
  } catch (error) {
    return { state: "unverified", reason: caught(error), thrown: true };
  }
}
/** The kind's inventory; what it throws (a platform error or a defect) fails it the same way. */
async function inventory(kind: CollectionKind): Promise<Outcome<Resource[]>> {
  try {
    return await kind.inventory();
  } catch (error) {
    return failed("thrown", caught(error), error);
  }
}
function scope(kind: CollectionKind): { repository?: string } {
  return kind.repository ? { repository: kind.repository } : {};
}
/** `base`, overlaid with `overlay` where it sets any field. */
function mergedDetails(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base;
  return {
    ...(isMapping(base) ? base : {}),
    ...(isMapping(overlay) ? overlay : {}),
  };
}
function refuseReportOnly(line: ReceiptLine, proof: Proof): boolean {
  if (!proof.reportOnly) return false;
  line.outcome = "refused";
  line.proof = proof.reason;
  line.reason = proof.reportOnly;
  return true;
}
async function collectResource(
  kind: CollectionKind,
  resource: Resource,
  line: ReceiptLine,
  persist: () => void,
): Promise<void> {
  await kind.exclusive(async () => {
    const final = await prove(kind, resource);
    line.reason = final.reason;
    line.outcome = outcome(final);
    const details = mergedDetails(resource.details, final.details);
    if (details !== undefined) line.details = details;
    if (final.state !== "dead" || refuseReportOnly(line, final)) return;
    line.proof = final.reason;
    line.outcome = "unverified";
    line.reason = "collection started; completion not yet recorded";
    persist();
    const collected = await kind.collect(resource);
    const before = line.details;
    Object.assign(line, collected);
    const merged = mergedDetails(before, collected.details);
    if (merged !== undefined) line.details = merged;
  });
}
async function evaluate(
  kind: CollectionKind,
  resource: Resource,
  receipt: Receipt,
  persist: () => void,
): Promise<void> {
  const proof = await prove(kind, resource);
  if (proof.thrown) receipt.exitStatus = 1;
  const line: ReceiptLine = {
    kind: kind.name,
    ...scope(kind),
    resource: resource.id,
    description: kind.describe(resource),
    outcome: outcome(proof),
    reason: proof.reason,
  };
  const details = mergedDetails(resource.details, proof.details);
  if (details !== undefined) line.details = details;
  if (resource.bytes !== undefined) line.bytes = resource.bytes;
  receipt.resources.push(line);
  if (
    refuseReportOnly(line, proof) ||
    !receipt.collect ||
    proof.state !== "dead"
  )
    return;
  try {
    await collectResource(kind, resource, line, persist);
  } catch (error) {
    line.outcome = "failed";
    line.reason = caught(error);
  }
  if (line.outcome === "failed") receipt.exitStatus = 1;
}
async function evaluateKind(
  kind: CollectionKind,
  receipt: Receipt,
  persist: () => void,
): Promise<void> {
  const listed = await inventory(kind);
  if (!listed.ok) {
    receipt.resources.push({
      kind: kind.name,
      ...scope(kind),
      resource: "*",
      description: "inventory",
      outcome: "unverified",
      reason: listed.failure.reason,
    });
    receipt.exitStatus = 1;
    return;
  }
  for (const resource of listed.value) {
    await evaluate(kind, resource, receipt, persist);
    persist();
  }
}
/** The exit of a command whose configuration gc refuses. */
const CONFIGURATION_EXIT = 2;
/**
 * The exit for a failure that stops a gc command before it does anything: a
 * refused configuration exits 2 with its reason alone on standard error;
 * anything else exits 1 with its reason logged as an error (`failureExit`).
 */
export function stopped(failure: Failure): number {
  if (failure.code === "configuration") {
    console.error(failure.reason);
    return CONFIGURATION_EXIT;
  }
  return failureExit(failure);
}
function newReceipt(collect: boolean): Receipt {
  const startedAt = new Date().toISOString();
  const receipt: Receipt = {
    version: 1,
    runId: `${startedAt.replace(/:/g, "-")}-${process.pid}-${randomUUID()}`,
    startedAt,
    finishedAt: startedAt,
    collect,
    completed: false,
    kinds: [],
    resources: [],
    exitStatus: 0,
  };
  const upgrade = scheduledUpgradeOf();
  if (upgrade !== undefined) receipt.upgrade = upgrade;
  return receipt;
}
/**
 * The receipt of a run that planned no kind because of `failure`: it names
 * the failure, collected nothing and ended with `exitStatus`. It records
 * completion, since nothing was left in flight, so retention can expire it.
 */
export function recordFailedRun(
  failure: Failure,
  exitStatus: number,
  options: { collect: boolean; receiptRoot?: string },
): { receipt: Receipt; path: string } {
  const receipt = newReceipt(options.collect);
  receipt.completed = true;
  receipt.exitStatus = exitStatus;
  receipt.failure = { code: failure.code, reason: failure.reason };
  return { receipt, path: writeReceipt(receipt, options.receiptRoot) };
}
/** A receipt exists before any action; each removal records intent and proof first. */
export async function runCollection(
  kinds: CollectionKind[],
  options: { collect: boolean; receiptRoot?: string },
): Promise<{ receipt: Receipt; path: string }> {
  const receipt = newReceipt(options.collect);
  receipt.kinds = kinds.map((kind) => ({
    name: kind.name,
    ...scope(kind),
    declaration: kind.declaration,
  }));
  const journal = openReceipt(receipt, options.receiptRoot);
  for (const kind of kinds) {
    await evaluateKind(kind, receipt, journal.update);
    journal.update();
  }
  receipt.completed = true;
  receipt.finishedAt = new Date().toISOString();
  journal.update();
  return { receipt, path: journal.path };
}
function familyLines(line: ReceiptLine): string[] {
  if (!isMapping(line.details)) return [];
  return ["retire", "keep"].flatMap((action) => {
    const entries =
      line.details && isMapping(line.details)
        ? line.details[action]
        : undefined;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(isMapping)
      .map(
        (entry) =>
          `  ${String(entry.id)}: ${action === "retire" ? "would retire" : "keep"} — ${String(entry.reason)}`,
      );
  });
}
/**
 * The workspace runtime a line's resource is managed by, when one is, and
 * whether its launches were guarded (`orca, unguarded`).
 */
function runtimeOf(line: ReceiptLine): string {
  if (
    !isMapping(line.details) ||
    typeof line.details.runtime !== "string" ||
    line.details.runtime === "none"
  )
    return "";
  const guard =
    typeof line.details.guard === "string" ? `, ${line.details.guard}` : "";
  return ` (${line.details.runtime}${guard})`;
}
export function formatReceipt(receipt: Receipt): string {
  const declarations = receipt.kinds.map(
    (kind) =>
      `${kind.name} ${kind.repository ?? "machine"}: declaration ${kind.declaration}`,
  );
  const lines = receipt.resources.flatMap((line) => [
    `${line.kind} ${line.repository ?? "machine"} ${line.resource}${runtimeOf(line)}: ${line.outcome} — ${line.reason}${line.bytes === undefined ? "" : ` (${line.bytes} bytes)`}`,
    ...familyLines(line),
  ]);
  return [
    ...(receipt.upgrade === undefined
      ? []
      : [`upgrade: ${upgradeLine(receipt.upgrade)}`]),
    ...declarations,
    ...lines,
    ...(receipt.failure === undefined
      ? []
      : [`failure (${receipt.failure.code}): ${receipt.failure.reason}`]),
    `gc ${receipt.runId}: exit ${receipt.exitStatus}`,
  ].join("\n");
}
