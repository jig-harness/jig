/** A bound answer cannot bridge a local framing and a lagging published one. */
import type { ParkedItem } from "../state/park-frame.ts";
import type { PendingAnswer } from "../state/pass-handoff.ts";
import { readLedgerSnapshot } from "../state/ledger-forge.ts";
import type { LedgerSnapshot } from "../state/ledger.ts";
import { ledgerDriverFromEnv } from "../state/ledger-mirror.ts";

export function answerPublicationLag(
  item: ParkedItem,
  answers: readonly PendingAnswer[],
  published: readonly ParkedItem[],
): boolean {
  if (item.digest === undefined) return false;
  const ledger = published.find(
    (p) => p.key === item.key && p.kind === item.kind,
  );
  if (ledger?.digest === item.digest) return false;
  return answers.some(
    (a) =>
      a.digest !== undefined &&
      (a.digest === item.digest || a.digest === ledger?.digest),
  );
}

/** Explain why a framing comparison has no trustworthy published ledger. */
export function publicationLedgerDiagnostic(
  snapshot: LedgerSnapshot,
): string | null {
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind === "unknown-version")
    return `the published ledger uses unsupported ledgerVersion ${parsed.version}`;
  if (snapshot.malformed.length > 0)
    return `the published ledger has ${snapshot.malformed.length} damaged comment(s)`;
  if (parsed?.kind !== "ledger") return "no trusted published ledger exists";
  return null;
}

/** No readable ledger is no comparison; legacy and digest-free answers keep their rule. */
export async function laggingAnswerPublication(
  pr: number,
  parks: readonly ParkedItem[],
  answers: (key: string) => readonly PendingAnswer[],
): Promise<string[]> {
  if (
    !parks.some(
      (p) =>
        p.digest !== undefined &&
        answers(p.key).some((a) => a.digest !== undefined),
    )
  )
    return [];
  const snapshot = await readLedgerSnapshot(
    String(pr),
    ledgerDriverFromEnv()?.login ?? null,
  );
  if (typeof snapshot === "string") {
    console.error(
      `re-arm: could not compare answer framing with the published ledger: ${snapshot}; using local framing and park time.`,
    );
    return [];
  }
  const diagnostic = publicationLedgerDiagnostic(snapshot);
  if (diagnostic !== null) {
    console.error(
      `re-arm: could not compare answer framing with the published ledger: ${diagnostic}; using local framing and park time.`,
    );
    return [];
  }
  const published = snapshot.canonical.parsed.ledger.parked;
  return parks
    .filter((p) => answerPublicationLag(p, answers(p.key), published))
    .map((p) => p.key);
}
