/** Immutable merge state and complete changed files, independent of follow-up activation. */
import { parseMs } from "../../shared/time.ts";
import { swallow } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import { stateRoot } from "../receipts.ts";
import { stateDb } from "./state.ts";

export interface MergeFact {
  mergedAt: string;
  base: string;
  files: string[];
}

export function isMergeFact(value: unknown): value is MergeFact {
  return (
    isRecord(value) &&
    typeof value.mergedAt === "string" &&
    Number.isFinite(parseMs(value.mergedAt)) &&
    typeof value.base === "string" &&
    value.base.length > 0 &&
    Array.isArray(value.files) &&
    value.files.every((file) => typeof file === "string")
  );
}

export function readMergeFact(
  repo: string,
  pr: number,
  root = stateRoot(),
): MergeFact | null {
  try {
    const row = stateDb(root)
      .query("SELECT fact FROM merge_facts WHERE repo = ? AND pr = ?")
      .get(repo, pr) as { fact: string } | null;
    const value: unknown = row === null ? null : JSON.parse(row.fact);
    return isMergeFact(value) ? value : null;
  } catch (error) {
    swallow(
      error,
      "unreadable immutable merge facts require another forge read",
    );
    return null;
  }
}

export function writeMergeFact(
  repo: string,
  pr: number,
  fact: MergeFact,
  root = stateRoot(),
): void {
  try {
    stateDb(root)
      .query(
        "INSERT OR IGNORE INTO merge_facts (repo, pr, fact) VALUES (?, ?, ?)",
      )
      .run(repo, pr, JSON.stringify(fact));
  } catch (error) {
    swallow(error, "merge facts not kept require another forge read");
  }
}
