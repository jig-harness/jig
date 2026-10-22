import { lstatSync, rmSync } from "node:fs";
import { exclusiveGcLock } from "../../shared/gc-lock.ts";
import { readReceipt, receiptPaths, stateRoot } from "../receipts.ts";
import type { CollectionKind, Proof } from "../types.ts";

function scopeKey(kind: { name: string; repository?: string }): string {
  return JSON.stringify([kind.name, kind.repository ?? null]);
}
/** The newest receipt path for every kind and repository the archive covers. */
function latestByScope(root: string): Map<string, string> {
  const latest = new Map<string, { path: string; startedAt: string }>();
  for (const path of receiptPaths(root)) {
    const receipt = readReceipt(path);
    for (const kind of receipt.kinds) {
      const key = scopeKey(kind);
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
  return new Map([...latest].map(([key, { path }]) => [key, path]));
}
export function receiptsKind(days: number, root = stateRoot()): CollectionKind {
  // Built once per census. Receipts written later are newer, so an index
  // missing them can only keep a candidate, never remove the latest.
  let latest: Map<string, string> | undefined;
  return {
    name: "receipts",
    declaration: "machine gc.receipts_days",
    inventory: async () => {
      latest = latestByScope(root);
      return receiptPaths(root).map((id) => ({
        id,
        bytes: lstatSync(id).size,
      }));
    },
    prove: async (resource): Promise<Proof> => {
      if (!lstatSync(resource.id).isFile())
        return { state: "finding", reason: "receipt is not a regular file" };
      const candidate = readReceipt(resource.id);
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
      latest ??= latestByScope(root);
      for (const kind of candidate.kinds)
        if (latest.get(scopeKey(kind)) === resource.id)
          return {
            state: "live",
            reason: `most recent receipt for ${kind.name} ${kind.repository ?? "machine"}`,
          };
      return {
        state: "dead",
        reason:
          "receipt retention elapsed; newer receipts cover every evaluated kind",
      };
    },
    collect: async (resource) => {
      rmSync(resource.id);
      return { outcome: "collected", reason: "expired receipt removed" };
    },
    describe: (resource) => resource.id,
    exclusive: (body) => exclusiveGcLock("receipts", body),
  };
}
