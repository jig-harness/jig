import { lstatSync, rmSync } from "node:fs";
import { exclusiveGcLock } from "../../shared/gc-lock.ts";
import { readReceipt, receiptPaths, stateRoot } from "../receipts.ts";
import type { CollectionKind, Proof } from "../types.ts";

export function receiptsKind(days: number, root = stateRoot()): CollectionKind {
  return {
    name: "receipts",
    declaration: "machine gc.receipts_days",
    inventory: async () =>
      receiptPaths(root).map((id) => ({ id, bytes: lstatSync(id).size })),
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
      const all = receiptPaths(root).map((path) => ({
        path,
        receipt: readReceipt(path),
      }));
      for (const kind of candidate.kinds) {
        const latest = all
          .filter(({ receipt }) =>
            receipt.kinds.some(
              (other) =>
                kind.name === other.name &&
                kind.repository === other.repository,
            ),
          )
          .sort(
            (a, b) =>
              b.receipt.startedAt.localeCompare(a.receipt.startedAt) ||
              b.path.localeCompare(a.path),
          )[0];
        if (latest?.path === resource.id)
          return {
            state: "live",
            reason: `most recent receipt for ${kind.name} ${kind.repository ?? "machine"}`,
          };
      }
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
