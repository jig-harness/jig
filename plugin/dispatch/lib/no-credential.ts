/**
 * A tick that has no credential for a tracker fails closed for it. The
 * tracker's transport learns it at the tick's first call to that tracker
 * and sends it nothing more (`shared/outbound/missing-credential.ts`); this
 * module says so once, on the tick's log and receipt (`noCredential`),
 * rather than on every read, card and account it touched.
 *
 * Each repository's report keeps no failure the missing credential caused
 * (a read whose failure carries the no-credential mark):
 * its tracker record says it was not asked, and the rows a refused read
 * left go, so no repository's turn fails for it and the issue preflight
 * holds no account for it (`preflight.ts`). The tick as a whole exits with
 * the `unauthorized` class's status (`EXIT_OF_CLASS`) when nothing else
 * failed, and 1 when something did; at that status the failure ledger
 * counts the tick's own row as a failure told at once, naming the missing
 * credential (`tick-settle.ts`), so a person hears of it. The line keeps
 * each such repository's tracker part from the last reading that had a
 * credential (`line-keyless.ts`).
 */
import {
  EXIT_OF_CLASS,
  type FailureClass,
} from "../../shared/outbound/failure.ts";
import {
  type MissingCredential,
  missingCredentialMessage,
  missingCredentials,
  notedMissingCredentials,
} from "../../shared/outbound/missing-credential.ts";
import { issueService } from "../../shared/tracker-product.ts";
import type { TickReceipt } from "../receipts.ts";
import type { RepoReport } from "./types.ts";

/** A system the tick had no credential for, as its receipt names it once. */
export interface NoCredential {
  system: string;
  class: FailureClass;
  /** What is missing, in a few words: `no Linear key configured`. */
  reason: string;
  /** What gives the tick one: the variables looked for and the client's login. */
  remedy: string;
  /** What the client answered, when one was asked. */
  answer?: string;
  /** Set when a later call of the tick had a credential and no repository's reading was cut by the missing one: the incident is history, and neither the exit nor the line's kept part follow it. */
  recovered?: true;
  /** The repositories whose tracker it is, by slug (by path when the forge did not name one). */
  repos: string[];
  /** The repositories whose previous tracker part the line keeps: those whose reading the missing credential cut. A tick that found the credential missing after its readings succeeded (a launch-time revalidation) names its repositories in `repos` and keeps none, so a fresh reading is never replaced. Absent in a receipt written before the field: `repos` then. */
  kept?: string[];
}

/** What a repository's tracker record says when the tick could not ask the tracker. */
function notAsked(system: string): string {
  return `not asked: the tick has no ${issueService(system)} credential (its receipt's noCredential says what is missing), so the line keeps the last reading that had one`;
}

/**
 * Take out of `report` what the missing credential caused: the reads whose
 * failure carries the no-credential mark (`ReadFailure.noCredential`), never
 * one any other failure cut. Whether its tracker is the system's.
 */
function settleReport(
  report: RepoReport,
  missing: MissingCredential,
): { tracked: boolean; cut: boolean } {
  let tracked = false;
  let cut = false;
  report.records = report.records.map((record) => {
    if (record.record !== "tracker") return record;
    if (record.source.startsWith(`${missing.system} `)) tracked = true;
    if (record.ok || record.failure?.noCredential !== true) return record;
    tracked = true;
    cut = true;
    const { failure: _failure, ...kept } = record;
    return { ...kept, ok: true, detail: notAsked(missing.system) };
  });
  const before = report.unplaced.length;
  report.unplaced = report.unplaced.filter(
    (row) => row.failure?.noCredential !== true,
  );
  const unplacedCut = report.unplaced.length < before;
  return { tracked: tracked || unplacedCut, cut: cut || unplacedCut };
}

/**
 * Put the systems this tick had no credential for on its receipt, once
 * each, with the repositories they track; take what that caused out of each
 * repository's report, and say it once on the tick's log.
 */
export function settleNoCredential(receipt: TickReceipt): void {
  const missing = notedMissingCredentials();
  if (missing.length === 0) return;
  const active = new Set(missingCredentials().map((m) => m.system));
  receipt.noCredential = missing.map((m) => {
    // A later call's success recovers the system only when no repository's reading was cut by the missing credential: a cut reading was never retried.
    const tracked: string[] = [];
    const cut: string[] = [];
    for (const report of receipt.repos) {
      const settled = settleReport(report, m);
      const name = report.slug ?? report.path;
      if (settled.tracked) tracked.push(name);
      if (settled.cut) cut.push(name);
    }
    const cutAny = cut.length > 0;
    // The incident belongs to the readings it cut, and only those keep their previous part: a repository read before the credential was lost keeps its fresh reading. With no reading cut (the credential was found missing after the readings succeeded) every tracked repository is named, and none is kept.
    const repos = cutAny ? cut : tracked;
    console.error(
      `jig dispatch: ${missingCredentialMessage(m)}; the tick asked ${issueService(m.system)} nothing more, and the line keeps the last reading that had a credential`,
    );
    return {
      system: m.system,
      class: "unauthorized",
      reason: m.reason,
      remedy: m.remedy,
      ...(m.answer === undefined ? {} : { answer: m.answer }),
      ...(active.has(m.system) || cutAny ? {} : { recovered: true as const }),
      repos,
      kept: cut,
    };
  });
}

/** The exit of a tick that had no credential for a tracker: the `unauthorized` class's; `null` for a tick that had every one. */
export function noCredentialExit(receipt: TickReceipt): number | null {
  return (receipt.noCredential ?? []).some((n) => n.recovered !== true)
    ? EXIT_OF_CLASS.unauthorized
    : null;
}

/** The trackers the tick had no credential for, by adapter, each with its reason: what the line marks a kept part with. */
export function keylessSystems(receipt: TickReceipt): Map<string, string> {
  return new Map(
    (receipt.noCredential ?? [])
      .filter((n) => n.recovered !== true)
      .map((n) => [n.system, n.reason]),
  );
}

/** The repositories whose tracker part the line keeps for each keyless system, by slug (by path when the forge did not name one). */
export function keylessRepos(
  receipt: TickReceipt,
): Map<string, ReadonlySet<string>> {
  return new Map(
    (receipt.noCredential ?? [])
      .filter((n) => n.recovered !== true)
      .map((n) => [n.system, new Set(n.kept ?? n.repos)]),
  );
}
