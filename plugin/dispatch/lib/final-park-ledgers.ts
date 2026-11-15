/** Final receipts of pull requests the line held parks for before they left the open listing. */
import { snapshotFromListing } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { readLine } from "./line-store.ts";
import { ledgerParks, type FinalParks } from "./park-events.ts";
import { readFailureOf } from "./read-failures.ts";
import {
  CUT_AT_BOUND,
  ended,
  heldRead,
  passedBefore,
  type TickBound,
} from "./sources/bounded.ts";
import type { TickComments } from "./tick-comments.ts";
import type { RepoReport } from "./types.ts";

/** The class of a listing's failure, for the record; none for a listing that read or whose failure names no call. */
function failureField(listing: {
  ok: boolean;
  failure?: Parameters<typeof readFailureOf>[0];
}): { failure?: NonNullable<ReturnType<typeof readFailureOf>> } {
  const read =
    listing.ok || listing.failure === undefined
      ? undefined
      : readFailureOf(listing.failure);
  return read === undefined ? {} : { failure: read };
}

/**
 * A successful read retires its held parks; a failed read leaves them for
 * the next tick, as does one the tick's bound ended before it began.
 */
export async function finalParkLedgers(
  slug: string,
  open: readonly { number: number }[],
  login: string | null,
  comments: TickComments,
  report: RepoReport,
  bound?: TickBound,
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
  if (prs.length > 0 && ended(bound)) {
    report.records.push({
      record: "forge",
      source: `gh ${slug}`,
      ok: false,
      detail: `${passedBefore("the final drive ledgers were read")}; their parks stay held for the next tick`,
      failure: CUT_AT_BOUND,
    });
    return [];
  }
  const readings = await Promise.all(
    prs.map(async (number) => {
      const listing = await heldRead(
        bound,
        `the final drive ledger of #${number} was read`,
        () => comments.read(slug, number),
      );
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
        ...failureField(listing),
      });
      return null;
    }),
  );
  return readings.filter((r): r is FinalParks => r !== null);
}
