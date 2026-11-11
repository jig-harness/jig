/**
 * How each park left, for the outcome log: the tick's line keeps every park
 * on the ledgers it read, with its class, digest and the answers it read,
 * and the identities of the resolution receipts it has ingested
 * (`skills/drive-pr/scripts/lib/state/resolution-receipt.ts`). The next tick
 * that reads the whole machine file compares:
 *
 * | What the ledgers show | Event row |
 * | --- | --- |
 * | a receipt whose identity the line has not ingested, whether or not the line held its park | `park-answered`, or `park-provisional` for one handed on to be decided provisionally |
 * | a park the line held that is gone, with no receipt for it | `park-removed` |
 * | a park the line held on a pull request no longer open | `park-removed` |
 *
 * So a park raised and answered between two ticks is counted from its
 * receipt, and a park withdrawn or framed again is never counted as
 * answered. A park on a ledger this tick did not read stays held for a
 * later tick to judge. A row's key is the park occurrence, so no occurrence
 * is counted twice, and only the tick of the host that owns the repository
 * (`owner` in the machine file) writes rows. The line keeps an ingested
 * identity only while a ledger it read lists its receipt.
 */
import { answerView, answerWords } from "../../shared/decision-card.ts";
import {
  parkOccurrence,
  type ResolutionReceipt,
} from "../../skills/drive-pr/scripts/lib/state/resolution-receipt.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { LinePark } from "./dashboard-contract.ts";
import type { EventRow, ParkFacts } from "./log.ts";
import type { DrivenPr } from "./types.ts";

/** What a ledger that read holds of its parks: every park, and the receipts of those re-arms unparked. */
export interface LedgerParks {
  parked: Array<
    Pick<LinePark, "key" | "kind" | "digest" | "parkedAt"> & {
      class?: string;
    }
  >;
  resolved: ResolutionReceipt[];
}

export function ledgerParks(ledger: Ledger): LedgerParks {
  return {
    parked: ledger.parked.map((p) => ({
      key: p.key,
      kind: p.kind,
      ...(p.digest === undefined ? {} : { digest: p.digest }),
      ...(p.at === undefined ? {} : { parkedAt: p.at }),
      ...(p.class === undefined ? {} : { class: p.class }),
    })),
    resolved: ledger.resolvedParks ?? [],
  };
}

/** One repository as the tick read it. */
export interface ParkRepo {
  slug: string;
  owner: boolean;
  /** The open pull requests; `null` when the forge's listing did not read. */
  open: number[] | null;
  drives: DrivenPr[];
}

/** What the line carries from the tick before. */
export interface ParkMemory {
  parks?: LinePark[];
  ingested?: string[];
}

export interface ParkOutcomes {
  parks: LinePark[];
  ingested: string[];
  rows: EventRow[];
}

const identityOf = (p: LinePark): string | null =>
  p.parkedAt === undefined
    ? null
    : parkOccurrence(p.repo, p.pr, {
        key: p.key,
        ...(p.digest === undefined ? {} : { digest: p.digest }),
        parkedAt: p.parkedAt,
      });

function receiptIdentity(
  slug: string,
  pr: number,
  r: ResolutionReceipt,
): string {
  return parkOccurrence(slug, pr, {
    key: r.key,
    ...(r.digest === undefined ? {} : { digest: r.digest }),
    parkedAt: r.parkedAt,
  });
}

/** The parks a drive's ledger holds, with the answers the tick read for each. */
function parksOf(slug: string, d: DrivenPr): LinePark[] {
  return (d.parks?.parked ?? []).map((p) => {
    const read = d.waiting?.find((w) => w.key === p.key)?.answers ?? [];
    return {
      repo: slug,
      pr: d.number,
      key: p.key,
      kind: p.kind,
      ...(p.digest === undefined ? {} : { digest: p.digest }),
      ...(p.parkedAt === undefined ? {} : { parkedAt: p.parkedAt }),
      class: p.class ?? null,
      ...(read.length === 0 ? {} : { answers: read.map(answerView) }),
    };
  });
}

function spanMs(from: string, to: string | undefined): number | undefined {
  if (to === undefined) return undefined;
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) ? Math.max(0, span) : undefined;
}

/** What a receipt says of the choice: its form, whether it took the recommendation, whether a note narrowed it. */
function choiceFacts(
  r: ResolutionReceipt,
): Pick<ParkFacts, "form" | "recommended" | "note"> {
  if (r.outcome === "provisional" || r.answers.length === 0)
    return { form: null, recommended: null, note: false };
  const choice = r.answers[0]?.choice;
  if (choice === undefined)
    return { form: "free", recommended: null, note: false };
  return {
    form: choice.form,
    recommended: choice.recommended,
    note: r.answers.some((a) => a.choice?.note !== undefined),
  };
}

function receiptRow(slug: string, pr: number, r: ResolutionReceipt): EventRow {
  const facts = choiceFacts(r);
  const waited = spanMs(r.parkedAt, r.answeredAt ?? r.resolvedAt);
  const said =
    r.outcome === "provisional"
      ? "handed on unanswered, to be decided provisionally"
      : `answered: ${r.answers.map((a) => answerWords(answerView(a))).join("; ")}`;
  return {
    kind: "event",
    key: `park ${receiptIdentity(slug, pr, r)}`,
    at: r.resolvedAt,
    repo: slug,
    stage: "rearm",
    target: `PR #${pr}`,
    event: r.outcome === "provisional" ? "park-provisional" : "park-answered",
    account: null,
    class: null,
    reason: `${r.kind} ${r.key}${r.class === undefined ? "" : ` (class ${r.class})`} ${said}`,
    ...(waited === undefined ? {} : { durationMs: waited }),
    park: {
      key: r.key,
      class: r.class ?? null,
      digest: r.digest ?? null,
      parkedAt: r.parkedAt,
      outcome: r.outcome,
      ...facts,
    },
  };
}

function removedRow(
  p: LinePark,
  identity: string,
  why: string,
  nowIso: string,
): EventRow {
  return {
    kind: "event",
    key: `park ${identity}`,
    at: nowIso,
    repo: p.repo,
    stage: "rearm",
    target: `PR #${p.pr}`,
    event: "park-removed",
    account: null,
    class: null,
    reason: `${p.kind} ${p.key}${p.class === null ? "" : ` (class ${p.class})`} left the ledger with no resolution receipt: ${why}`,
    park: {
      key: p.key,
      class: p.class,
      digest: p.digest ?? null,
      parkedAt: p.parkedAt ?? nowIso,
      outcome: "removed",
      form: null,
      recommended: null,
      note: false,
    },
  };
}

/** Every receipt the repository's ledgers list, by identity, with the pull request it is on. */
function receiptsOf(
  slug: string,
  read: ReadonlyMap<number, DrivenPr>,
): Map<string, { pr: number; receipt: ResolutionReceipt }> {
  const out = new Map<string, { pr: number; receipt: ResolutionReceipt }>();
  for (const d of read.values())
    for (const receipt of d.parks?.resolved ?? [])
      out.set(receiptIdentity(slug, d.number, receipt), {
        pr: d.number,
        receipt,
      });
  return out;
}

/** Why a held park no longer is, as far as this tick can tell; `null` when it cannot. */
function goneWhy(
  repo: ParkRepo,
  read: ReadonlyMap<number, DrivenPr>,
  pr: number,
): string | null {
  if (read.has(pr)) return "it was withdrawn or framed again";
  return repo.open !== null && !repo.open.includes(pr)
    ? "its pull request is no longer open"
    : null;
}

/** One repository's parks, ingested receipts and rows. */
function repoOutcomes(
  repo: ParkRepo,
  memory: ParkMemory,
  nowIso: string,
): ParkOutcomes {
  const read = new Map(
    repo.drives.flatMap((d) =>
      d.parks === undefined ? [] : [[d.number, d] as const],
    ),
  );
  const parks = [...read.values()].flatMap((d) => parksOf(repo.slug, d));
  const held = new Set(parks.map(identityOf));
  const receipts = receiptsOf(repo.slug, read);
  const before = new Set(memory.ingested ?? []);
  const ingested = repo.owner ? [...receipts.keys()] : [];
  const rows = ingested
    .filter((identity) => !before.has(identity))
    .flatMap((identity) => {
      const found = receipts.get(identity);
      return found === undefined
        ? []
        : [receiptRow(repo.slug, found.pr, found.receipt)];
    });
  for (const p of memory.parks ?? []) {
    const identity = p.repo === repo.slug ? identityOf(p) : null;
    if (identity === null || held.has(identity) || receipts.has(identity))
      continue;
    const why = goneWhy(repo, read, p.pr);
    if (why === null) parks.push(p);
    else if (repo.owner) rows.push(removedRow(p, identity, why, nowIso));
  }
  return { parks, ingested, rows };
}

/**
 * Every repository's parks and ingested receipts for the line, and the
 * event rows of the parks that left since the line before.
 */
export function parkOutcomes(
  repos: readonly ParkRepo[],
  memory: ParkMemory,
  nowIso: string,
): ParkOutcomes {
  const each = repos.map((r) => repoOutcomes(r, memory, nowIso));
  return {
    parks: each.flatMap((o) => o.parks),
    ingested: each.flatMap((o) => o.ingested),
    rows: each.flatMap((o) => o.rows),
  };
}
