import { randomUUID } from "node:crypto";
import { openReceipt } from "./receipts.ts";
import { isMapping } from "../shared/config-layers.ts";
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
function outcome(proof: Proof): ReceiptLine["outcome"] {
  if (proof.state === "dead") return "would-collect";
  return proof.state === "live" ? "refused" : proof.state;
}
async function prove(kind: CollectionKind, resource: Resource): Promise<Proof> {
  try {
    return await kind.prove(resource);
  } catch (error) {
    return { state: "unverified", reason: message(error) };
  }
}
function scope(kind: CollectionKind): { repository?: string } {
  return kind.repository ? { repository: kind.repository } : {};
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
    if (final.state !== "dead" || refuseReportOnly(line, final)) return;
    line.proof = final.reason;
    line.outcome = "unverified";
    line.reason = "collection started; completion not yet recorded";
    persist();
    Object.assign(line, await kind.collect(resource));
  });
}
async function evaluate(
  kind: CollectionKind,
  resource: Resource,
  receipt: Receipt,
  persist: () => void,
): Promise<void> {
  const proof = await prove(kind, resource);
  const line: ReceiptLine = {
    kind: kind.name,
    ...scope(kind),
    resource: resource.id,
    description: kind.describe(resource),
    outcome: outcome(proof),
    reason: proof.reason,
  };
  if (resource.details !== undefined) line.details = resource.details;
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
    line.reason = message(error);
  }
  if (line.outcome === "failed") receipt.exitStatus = 1;
}
async function evaluateKind(
  kind: CollectionKind,
  receipt: Receipt,
  persist: () => void,
): Promise<void> {
  let resources: Resource[];
  try {
    resources = await kind.inventory();
  } catch (error) {
    receipt.resources.push({
      kind: kind.name,
      ...scope(kind),
      resource: "*",
      description: "inventory",
      outcome: "unverified",
      reason: message(error),
    });
    receipt.exitStatus = 1;
    return;
  }
  for (const resource of resources) {
    await evaluate(kind, resource, receipt, persist);
    persist();
  }
}
/** A receipt exists before any action; each removal records intent and proof first. */
export async function runCollection(
  kinds: CollectionKind[],
  options: { collect: boolean; receiptRoot?: string },
): Promise<{ receipt: Receipt; path: string }> {
  const startedAt = new Date().toISOString();
  const receipt: Receipt = {
    version: 1,
    runId: `${startedAt.replace(/:/g, "-")}-${process.pid}-${randomUUID()}`,
    startedAt,
    finishedAt: startedAt,
    collect: options.collect,
    completed: false,
    kinds: kinds.map((kind) => ({
      name: kind.name,
      ...scope(kind),
      declaration: kind.declaration,
    })),
    resources: [],
    exitStatus: 0,
  };
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
/** The workspace runtime a line's resource is managed by, when one is. */
function runtimeOf(line: ReceiptLine): string {
  return isMapping(line.details) &&
    typeof line.details.runtime === "string" &&
    line.details.runtime !== "none"
    ? ` (${line.details.runtime})`
    : "";
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
    ...declarations,
    ...lines,
    `gc ${receipt.runId}: exit ${receipt.exitStatus}`,
  ].join("\n");
}
