import { lstatSync, rmSync } from "node:fs";
import { exclusiveGcLock } from "../../shared/gc-lock.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import { readReceipt, receiptPaths, stateRoot } from "../receipts.ts";
import { archivedAt, archivePaths } from "../legacy-archive.ts";
import type { CollectionKind, Proof, Receipt } from "../types.ts";

function scopeKey(kind: {
  name: string;
  repository?: string | undefined;
}): string {
  return JSON.stringify([kind.name, kind.repository ?? null]);
}
/** A scope whose inventory failed reported nothing about its resources. */
function inventoryFailed(receipt: Receipt, key: string): boolean {
  return receipt.resources.some(
    (line) =>
      line.resource === "*" &&
      line.description === "inventory" &&
      scopeKey({ name: line.kind, repository: line.repository }) === key,
  );
}
/**
 * The newest completed report for every kind and repository the archive
 * covers. Unfinished receipts are preserved on their own and never displace it.
 */
function latestByScope(root: string): Outcome<Map<string, string>> {
  const latest = new Map<string, { path: string; startedAt: string }>();
  for (const path of receiptPaths(root)) {
    const read = readReceipt(path);
    if (!read.ok) return read;
    const receipt = read.value;
    if (!receipt.completed) continue;
    for (const kind of receipt.kinds) {
      const key = scopeKey(kind);
      if (inventoryFailed(receipt, key)) continue;
      const current = latest.get(key);
      if (
        !current ||
        receipt.startedAt.localeCompare(current.startedAt) > 0 ||
        (receipt.startedAt === current.startedAt &&
          path.localeCompare(current.path) > 0)
      )
        latest.set(key, { path, startedAt: receipt.startedAt });
    }
  }
  return ok(new Map([...latest].map(([key, { path }]) => [key, path])));
}
/**
 * A one-time archive of a removed worktree's ignored content expires with the
 * receipts: once the retention has passed since it was written. One whose
 * age cannot be read at all is kept.
 */
function archiveProof(path: string, days: number): Proof {
  if (!lstatSync(path).isDirectory())
    return { state: "finding", reason: "archive is not a directory" };
  const at = archivedAt(path);
  if (at === null)
    return {
      state: "unverified",
      reason: "archive age could not be read",
    };
  if (Date.now() - at < days * 86_400_000)
    return { state: "live", reason: "archive retention guard has not elapsed" };
  return { state: "dead", reason: "archive retention elapsed" };
}
export function receiptsKind(days: number, root = stateRoot()): CollectionKind {
  // Built once per census. Receipts written later are newer, so an index
  // missing them can only keep a candidate, never remove the latest.
  let latest: Map<string, string> | undefined;
  let archives = new Set<string>();
  return {
    name: "receipts",
    declaration: "machine gc.receipts_days",
    inventory: async () => {
      const index = latestByScope(root);
      if (!index.ok) return index;
      latest = index.value;
      archives = new Set(archivePaths(root));
      return ok([
        ...receiptPaths(root).map((id) => ({
          id,
          bytes: lstatSync(id).size,
        })),
        ...[...archives].map((id) => ({ id })),
      ]);
    },
    prove: async (resource): Promise<Proof> => {
      if (archives.has(resource.id)) return archiveProof(resource.id, days);
      if (!lstatSync(resource.id).isFile())
        return { state: "finding", reason: "receipt is not a regular file" };
      const read = readReceipt(resource.id);
      if (!read.ok) return { state: "unverified", reason: read.failure.reason };
      const candidate = read.value;
      if (!candidate.completed)
        return {
          state: "unverified",
          reason: "run did not record completion; preserve its action evidence",
        };
      if (Date.now() - Date.parse(candidate.startedAt) < days * 86_400_000)
        return {
          state: "live",
          reason: "receipt retention guard has not elapsed",
        };
      if (latest === undefined) {
        const index = latestByScope(root);
        if (!index.ok)
          return { state: "unverified", reason: index.failure.reason };
        latest = index.value;
      }
      for (const kind of candidate.kinds)
        if (latest.get(scopeKey(kind)) === resource.id)
          return {
            state: "live",
            reason: `most recent receipt for ${kind.name} ${kind.repository ?? "machine"}`,
          };
      return {
        state: "dead",
        reason:
          "receipt retention elapsed; newer completed reports cover every evaluated kind",
      };
    },
    collect: async (resource) => {
      if (archives.has(resource.id)) {
        rmSync(resource.id, { recursive: true });
        return { outcome: "collected", reason: "expired archive removed" };
      }
      rmSync(resource.id);
      return { outcome: "collected", reason: "expired receipt removed" };
    },
    describe: (resource) => resource.id,
    exclusive: (body) => exclusiveGcLock("receipts", body),
  };
}
