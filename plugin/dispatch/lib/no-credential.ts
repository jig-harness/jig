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
  /** The repositories whose tracker it is, by slug (by path when the forge did not name one). */
  repos: string[];
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
function settleReport(report: RepoReport, missing: MissingCredential): boolean {
  let tracked = false;
  report.records = report.records.map((record) => {
    if (record.record !== "tracker") return record;
    if (record.source.startsWith(`${missing.system} `)) tracked = true;
    if (record.ok || record.failure?.noCredential !== true) return record;
    tracked = true;
    const { failure: _failure, ...kept } = record;
    return { ...kept, ok: true, detail: notAsked(missing.system) };
  });
  const before = report.unplaced.length;
  report.unplaced = report.unplaced.filter(
    (row) => row.failure?.noCredential !== true,
  );
  return tracked || report.unplaced.length < before;
}

/**
 * Put the systems this tick had no credential for on its receipt, once
 * each, with the repositories they track; take what that caused out of each
 * repository's report, and say it once on the tick's log.
 */
export function settleNoCredential(receipt: TickReceipt): void {
  const missing = notedMissingCredentials();
  if (missing.length === 0) return;
  receipt.noCredential = missing.map((m) => {
    const repos = receipt.repos.flatMap((report) =>
      settleReport(report, m) ? [report.slug ?? report.path] : [],
    );
    console.error(
      `jig dispatch: ${missingCredentialMessage(m)}; the tick asked ${issueService(m.system)} nothing more, and the line keeps the last reading that had a credential`,
    );
    return {
      system: m.system,
      class: "unauthorized",
      reason: m.reason,
      remedy: m.remedy,
      ...(m.answer === undefined ? {} : { answer: m.answer }),
      repos,
    };
  });
}

/** The exit of a tick that had no credential for a tracker: the `unauthorized` class's; `null` for a tick that had every one. */
export function noCredentialExit(receipt: TickReceipt): number | null {
  return receipt.noCredential === undefined ? null : EXIT_OF_CLASS.unauthorized;
}

/** The trackers the tick had no credential for, by adapter, each with its reason: what the line marks a kept part with. */
export function keylessSystems(receipt: TickReceipt): Map<string, string> {
  return new Map((receipt.noCredential ?? []).map((n) => [n.system, n.reason]));
}
