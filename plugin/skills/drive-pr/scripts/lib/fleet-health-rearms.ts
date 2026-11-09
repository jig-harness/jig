/** Forge-backed re-arm history; a missing ledger differs from an unreadable one. */
import { readLedgerSnapshot, resolveLogin } from "./state/ledger-forge.ts";
import type { LedgerSnapshot } from "./state/ledger.ts";

export function rearmsFromSnapshot(
  snapshot: LedgerSnapshot | string,
): string[] | string {
  if (typeof snapshot === "string") return snapshot;
  const parsed = snapshot.canonical?.parsed;
  if (parsed === undefined)
    return snapshot.malformed.length > 0 ? "the forge ledger is malformed" : [];
  if (parsed.kind === "malformed") return parsed.reason;
  if (parsed.kind === "unknown-version")
    return `unsupported ledger version ${String(parsed.version)}`;
  if (parsed.ledger.events === undefined)
    return "the ledger predates re-arm event history";
  return parsed.ledger.events
    .filter((e) => e.kind === "rearm")
    .map((e) => e.at);
}

export function forgeRearmReader(
  repo: string,
): (pr: number, signal?: AbortSignal) => Promise<string[] | string> {
  let login: Promise<string | null> | undefined;
  return async (pr, signal) => {
    if (signal?.aborted) return "the collector deadline passed";
    login ??= resolveLogin(undefined, signal);
    const selfLogin = await login;
    if (signal?.aborted) return "the collector deadline passed";
    return rearmsFromSnapshot(
      await readLedgerSnapshot(String(pr), selfLogin, repo, signal),
    );
  };
}

/** Preserve an I/O dependency's diagnostic if it throws rather than returning one. */
export async function readRearmsWithReason(
  read: (pr: number, signal?: AbortSignal) => Promise<string[] | string | null>,
  pr: number,
  signal?: AbortSignal,
): Promise<string[] | string> {
  try {
    return (
      (await read(pr, signal)) ??
      "the forge ledger history could not be established"
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
