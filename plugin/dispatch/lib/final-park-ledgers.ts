/** Final receipts of pull requests the line held parks for before they left the open listing. */
import { snapshotFromListing } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { readLine } from "./line-store.ts";
import { ledgerParks, type FinalParks } from "./park-events.ts";
import type { TickComments } from "./tick-comments.ts";
import type { RepoReport } from "./types.ts";

/** A successful read retires its held parks; a failed read leaves them for the next tick. */
export async function finalParkLedgers(
  slug: string,
  open: readonly { number: number }[],
  login: string | null,
  comments: TickComments,
  report: RepoReport,
): Promise<FinalParks[]> {
  const before = readLine();
  if (!before.ok || before.value === null) return [];
  const opened = new Set(open.map((p) => p.number));
  const prs = [
    ...new Set(
      (before.value.parks ?? [])
        .filter((p) => p.repo === slug && !opened.has(p.pr))
        .map((p) => p.pr),
    ),
  ];
  const readings = await Promise.all(
    prs.map(async (number) => {
      const listing = await comments.read(slug, number);
      const snapshot = listing.ok
        ? snapshotFromListing(listing.value, login)
        : null;
      const parsed = snapshot?.canonical?.parsed;
      if (parsed?.kind === "ledger")
        return { number, parks: ledgerParks(parsed.ledger) };
      if (
        snapshot !== null &&
        snapshot.canonical === null &&
        snapshot.malformed.length === 0
      )
        return { number, parks: { parked: [], resolved: [] } };
      report.records.push({
        record: "forge",
        source: `gh ${slug}#${number}`,
        ok: false,
        detail: `the final drive ledger did not read; its parks stay held for the next tick${listing.ok ? "" : `: ${listing.failure.reason}`}`,
      });
      return null;
    }),
  );
  return readings.filter((r): r is FinalParks => r !== null);
}
