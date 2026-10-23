/**
 * A batch issue's KEY and its SCAFFOLD: the marker a round finds the batch by,
 * and the description a new batch starts from.
 *
 * Extracted from `defer-batch.ts`, which keeps the network layer, the
 * reconciliation rules and the entry rendering. Everything here is pure — no
 * I/O, no consumer configuration, no tracker client — so it is testable
 * directly and cannot drift against the caller's state.
 *
 * The two halves belong together: `initialDescription` is what WRITES the key,
 * `hasBatchKey` is what READS it, and `scaffoldPortion` is what bounds where
 * it may be read from. Splitting them would let the three disagree about where
 * in a description the key lives.
 */

/**
 * The batch's SEED title — display only, NOT the lookup key (that is
 * `batchKeyMarker` below). Written at creation and read by nothing, so a batch
 * may be retitled to say what it contains. While the title WAS the key, exact
 * equality plus create-on-miss meant a rename minted a duplicate, which is
 * both the failure batching exists to eliminate and why trackers accumulate
 * batches titled nothing but their PR number and Type.
 */
export function batchTitle(pr: string, type: string): string {
  return `PR #${pr} ${type} review follow-ups`;
}

/**
 * Is this value safe to embed in `batchKeyMarker`?
 *
 * The key's components are not a pinned taxonomy here: `type` and the
 * repository label come from consumer configuration
 * (`review.taxonomy.types` / `.repos`), so their contents are arbitrary
 * strings. Membership in the declared list — all `parseArgs` checks on its own
 * — says nothing about whether a value fits in a one-line HTML comment.
 * Whitespace undelimits `repo=` from the next field (a newline defeats the
 * whole-line match outright), `-->` closes the marker early, and `<!--` nests.
 *
 * A refusal rather than a sanitiser: a silently rewritten component would key
 * the batch under something no later round reconstructs.
 */
export function isSafeKeyComponent(value: string): boolean {
  return /^[A-Za-z0-9._:@+/-]+$/.test(value);
}

/**
 * Why `value` cannot be a batch-key component, or `undefined` when it can.
 *
 * Both questions in one place because they are one question — may this value
 * key a batch? — and asking them as two guards at each call site grew
 * `parseArgs`' already-critical branch count for no gain.
 *
 * Membership first: an unknown value is a configuration mistake, and
 * reporting the shape rule for it would misdirect the reader.
 */
export function keyComponentError(
  flag: string,
  value: string,
  declared: readonly string[],
  group: string,
  configPath: string,
): string | undefined {
  if (!declared.includes(value)) {
    return `${flag} must be one of ${declared.join("|")}, got '${value}' — the repository's declared ${group} taxonomy (consumer ${configPath})`;
  }
  if (!isSafeKeyComponent(value)) {
    return `${flag} '${value}' cannot be part of the batch key — it must match ${SAFE_KEY_COMPONENT_DESCRIPTION}. Rename it in the consumer's ${configPath}.`;
  }
  return undefined;
}

/** How `isSafeKeyComponent`'s rule reads in a refusal message. */
export const SAFE_KEY_COMPONENT_DESCRIPTION =
  "letters, digits, and any of . _ : @ + / - (no whitespace, and nothing that could open or close an HTML comment)";

/**
 * The cross-round lookup key, as a marker in the batch's DESCRIPTION — the one
 * field this script already authors and appends to. An HTML comment, so it
 * renders invisibly.
 *
 * It carries the repository, which the title never did: consumers share one
 * tracker workspace and pull-request numbers collide across them, so telling
 * two same-numbered batches apart used to fall to a Repo-LABEL check that had
 * to fail closed on an unlabelled or multiply-labelled candidate. A foreign
 * batch now simply does not match.
 *
 * `parseArgs` checks every component with `isSafeKeyComponent` first.
 */
export function batchKeyMarker(
  repoLabel: string,
  pr: string,
  type: string,
): string {
  return `<!-- defer-batch-key: repo=${repoLabel} pr=${pr} type=${type} -->`;
}

/**
 * Does this description carry this batch key?
 *
 * Two narrowings, both load-bearing: the server filter this backs is a
 * SUBSTRING match, so an issue merely QUOTING another batch's marker comes
 * back as a candidate, and claiming it would append the finding into a
 * different batch — the destructive direction.
 *
 * 1. Scoped to `scaffoldPortion`, above `## Entries`. Entry text is external
 *    and model-generated, and deferrals about this file quote markers
 *    verbatim. Same split, same reason, as `placementMatchesFreshParent`.
 * 2. A whole trimmed LINE, as `appendEntry` keys entry headings. `renderEntry`
 *    prefixes quoted lines with `> ` and labels reason/fix, so no rendered
 *    entry yields a bare marker line even before the scoping.
 *
 * Exact-case: the marker is machine-written, never typed.
 */
export function hasBatchKey(
  description: string,
  repoLabel: string,
  pr: string,
  type: string,
): boolean {
  const marker = batchKeyMarker(repoLabel, pr, type);
  return scaffoldPortion(description)
    .split("\n")
    .some((line) => line.trim() === marker);
}

/**
 * The domain-mismatch exception's audit trail: the protocol requires a
 * parentless follow-up to state WHY no epic holds it and which epic was
 * rejected, so `--no-parent` carries both rather than silently dropping the
 * parent (deferral-protocol.md § Parent).
 */
export interface NoParentRationale {
  reason: string;
  /**
   * The originating issue's own epic, `''` when it had none to reject, or
   * `null` when this run genuinely does not KNOW which of those two is
   * true (a repair reconstructing a wiped description with no rationale of
   * its own to fall back on — see `noParentRationaleForRepair`). `''` and
   * `null` render differently in `initialDescription`: `''` is an asserted
   * fact ("no epic to inherit"), `null` is an admitted gap. Collapsing the
   * two would assert a fact this run never verified.
   */
  rejectedEpic: string | null;
}

/**
 * The scaffold a freshly created batch issue starts from.
 *
 * The `batchKeyMarker` line comes FIRST: it is the key every later round
 * finds this batch by, so it must sit in the scaffold slice `hasBatchKey`
 * reads (above `## Entries`), survive every rebuild, and stay put when a
 * person edits the prose below it.
 */
export function initialDescription(
  repoLabel: string,
  pr: string,
  type: string,
  originating: string,
  noParent?: NoParentRationale,
): string {
  const provenance =
    originating === ""
      ? `Batch of review deferrals from PR #${pr} (no originating issue — PR has no ticket).`
      : `Batch of review deferrals from PR #${pr}; originating issue ${originating}.`;
  const lines = [
    batchKeyMarker(repoLabel, pr, type),
    "",
    provenance,
    "",
    "Filed per the batch-by-default rule in Jig's resolve-review-comments",
    "`references/deferral-protocol.md` § Batching",
    "is the default. Each entry is self-contained: the review-source URL, the",
    "reviewer's finding quoted, and why it was deferred rather than fixed in the PR.",
  ];
  if (noParent !== undefined) {
    // THREE renderings, not two: `null` must not fall into either asserted
    // branch below — see `NoParentRationale.rejectedEpic`'s own doc. Only
    // `''` (a verified fact: this run read the originating issue and it had
    // no epic) and a real identifier (a verified fact: this run read the
    // originating issue and rejected its named epic) are assertions this
    // scaffold is entitled to make.
    const placement =
      noParent.rejectedEpic === null
        ? ""
        : noParent.rejectedEpic === ""
          ? " (the originating issue has no epic to inherit)."
          : ` Originating issue's epic is ${noParent.rejectedEpic} (rejected as unrelated).`;
    lines.push("", `**No epic parent**: ${noParent.reason}${placement}`);
  }
  lines.push("", "## Entries");
  return lines.join("\n");
}

/**
 * The no-parent scaffold to use when rebuilding a WIPED description (a
 * hand-filed/partial batch, or a concurrent writer's blank-out mid-append) —
 * derived from the batch's OWN current placement, not this invocation's
 * `noParentRationale`.
 *
 * RECONCILE never touches a batch's `parentId` (see the file header): it
 * belongs to whichever entry filed the batch FIRST, and an append neither
 * changes nor reads it. A repair that rebuilt the scaffold from THIS
 * invocation's own `--no-parent` flag ignored that entirely — an append that
 * happens to pass `--no-parent` onto a batch whose first entry selected a
 * normal epic parent left the issue's `parentId` field untouched (still
 * parented) while its just-rebuilt description asserted
 * `**No epic parent**` and named THIS run's rejected epic, corrupting the
 * placement audit trail a reader relies on. `hasParent` is read from a fresh
 * query of the batch's actual `parent` field, not from `args.noParent`.
 *
 * When the batch genuinely has no parent, `invocationRationale` is NEVER
 * reused here — even when this run happens to have one of its own. Having
 * one only proves THIS append also passed `--no-parent`; it proves nothing
 * about whether that reason matches the reason the batch's FIRST entry was
 * originally placed parentless. Those can differ (a different originating
 * issue, a different rejected epic), and presenting one as the other writes
 * false placement provenance into the audit trail. A repair therefore always falls back to the
 * generic placeholder that records the original reason as lost — with
 * `rejectedEpic: null`, NOT `''`. `''` is `initialDescription`'s rendering
 * for a VERIFIED fact ("the originating issue has no epic to inherit"),
 * which this fallback has no way to know: the batch could equally have been
 * filed parentless because ITS OWN originating issue rejected a real epic.
 * Reusing `''` here rendered a description that both admitted the reason
 * was unrecoverable AND asserted a specific, possibly false, one in the same
 * sentence.
 */
export function noParentRationaleForRepair(
  hasParent: boolean,
): NoParentRationale | undefined {
  if (hasParent) return undefined;
  return {
    reason:
      "the batch was filed with no epic parent; the original reason was lost when its description was cleared and this repair could not recover it",
    rejectedEpic: null,
  };
}

/**
 * The description this run should treat the batch as starting from: the
 * LIVE description when non-empty, otherwise a freshly built scaffold whose
 * no-parent block (if any) is derived from `hasParent` alone via
 * `noParentRationaleForRepair` — this invocation's own rationale is never
 * consulted, because it describes why THIS append used `--no-parent`, not
 * why the batch was originally placed parentless.
 *
 * Called from ONE site: `appendWithRetry`'s mid-loop rebuild, after a
 * concurrent writer clobbers the description. Testing this function directly
 * covers the logic but NOT the wiring, so that call site is exercised
 * separately against a mock `LinearClient` — `main()` was extracted into
 * `runDeferBatch` for exactly that reason, after a rebuild reachable by no
 * test let a regression through.
 *
 * The rebuild also restores the `batchKeyMarker` line, now the LOOKUP KEY
 * rather than mere prose: without it a writer blanking the description
 * mid-append would leave the batch permanently unfindable. `runDeferBatch` no
 * longer rebuilds — a candidate gets there by matching the marker in the very
 * description passed here, so a blank one cannot arrive; a batch wiped while
 * no run is in flight is simply unfindable, its entries gone with it, so a
 * fresh batch is honest rather than appending to an empty husk.
 */
export function descriptionForRepair(
  liveDescription: string,
  repoLabel: string,
  pr: string,
  type: string,
  originating: string,
  hasParent: boolean,
): string {
  return liveDescription.trim() === ""
    ? initialDescription(
        repoLabel,
        pr,
        type,
        originating,
        noParentRationaleForRepair(hasParent),
      )
    : liveDescription;
}

/**
 * The SCAFFOLD slice of a batch description — everything `initialDescription`
 * writes (provenance, the batching-protocol note, and the `**No epic
 * parent**` placement claim when present) — as opposed to `## Entries` and
 * everything after it.
 *
 * Every placement check must be scoped to this slice, never the whole
 * description: an entry's finding/reason/fix-sketch is external,
 * model-generated text, so an unrestricted `description.includes('**No epic
 * parent**')` mistakes an entry that happens to quote that exact marker for
 * the scaffold's own claim (both in `placementMatchesFreshParent`, which is
 * why the split lives here once rather than being duplicated at each call
 * site).
 */
export function scaffoldPortion(description: string): string {
  return description.split("## Entries", 1)[0] ?? description;
}

/**
 * Does a description's own placement claim (its `**No epic parent**` block,
 * present or absent) agree with the issue's FRESHLY read `hasParent`?
 *
 * A mid-loop rebuild can race a reparent/unparent, so the REBUILT scaffold is
 * built from a `hasParent` already stale when written — the verify step
 * re-reads `parent` on every attempt, but until this function existed nothing
 * compared that fresh value against what the confirmed description CLAIMS.
 * Only meaningful for a description THIS run rebuilt (`appendWithRetry`'s
 * `everRebuiltScaffold`): an ordinary batch's claim predates this run, and
 * RECONCILE never touches it.
 */
export function placementMatchesFreshParent(
  description: string,
  hasParent: boolean,
): boolean {
  const claimsNoParent =
    scaffoldPortion(description).includes("**No epic parent**");
  return claimsNoParent === !hasParent;
}
