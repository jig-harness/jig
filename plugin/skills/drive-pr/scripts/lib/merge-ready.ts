/**
 * Ready to merge, exactly: one pure predicate the dispatcher's tick, the
 * merge-ready announcement and `jig ask` all call, so the board, the drive's
 * own comment and the answer a person gets about one pull request cannot
 * disagree (design/dispatch-board.md § Ready, exactly).
 *
 * It takes the facts of one converged pull request and places it: in Ready
 * to merge, lane **merge now**, **approve first** or **update next**; in Needs
 * you, with the person's act that settles it; in Coming, when a re-drive or
 * the pull request ahead of it settles it; or where it was, while the forge is
 * still computing. Each condition comes back met or not with the fact behind
 * it.
 *
 * Merge now never rests on the drive's ledger alone. The ledger is a comment
 * any collaborator can write, so the forge must witness a review of the head:
 * the reviewer app's own check run on it, where the repository names an app,
 * else a person's approving review of that head. A pull request from outside
 * the repository needs a person's approval whatever the app says.
 *
 * The rows of the placement table are first match, and every blocker other
 * than an approval comes before the approval rows, so a pull request enters
 * approve first only once the other conditions the read covers hold. Nothing
 * here reads signature or deployment rules, so approve first never says an
 * approval is the only act left.
 */

/** The lanes of Ready to merge, in the order of the work they ask. */
export const LANES = ["merge-now", "approve-first", "update-next"] as const;
export type Lane = (typeof LANES)[number];

/** The acts that settle a card that waits on a person: a closed list, the board's own words. */
export const ACTS = [
  "merge",
  "approve",
  "request-review",
  "update-branch",
  "answer",
  "re-arm",
  "re-run-check",
  "mark-ready",
  "remove-label",
  "open-pr",
] as const;
export type Act = (typeof ACTS)[number];

/** How an act reads in a sentence. */
export const ACT_WORDS: Record<Act, string> = {
  merge: "merge",
  approve: "approve",
  "request-review": "request a review",
  "update-branch": "update the branch",
  answer: "answer",
  "re-arm": "re-arm the drive",
  "re-run-check": "re-run a check",
  "mark-ready": "mark it ready",
  "remove-label": "remove the label",
  "open-pr": "open the pull request",
};

/** Where a converged pull request goes: Ready to merge, Needs you, Coming, or the column it was in. */
export type Placement = "ready" | "needs-you" | "coming" | "stay";

/** What a card waits on: something already under way, or a person's act. */
export type WaitsOn =
  | { kind: "waiting"; for: string }
  | { kind: "person"; act: Act };

/** One check context on the head, as the forge reports it. */
export interface HeadCheck {
  name: string;
  /** The app that posted a check run; `null` for a commit status. */
  app: string | null;
  required: boolean;
  state: "pending" | "success" | "neutral" | "skipped" | "failure";
  /** Monotonic check-run attempt id; absent for commit statuses or unread ids. */
  id?: number | null;
  /** When an ordinary check attempt started; reviewer witnesses use their attempt ids. */
  startedAt: string | null;
  /** When it completed, to order ordinary attempts whose starts match. */
  completedAt?: string | null;
}

/** A reviewer's latest review. */
export interface HeadReview {
  author: string;
  /** Whether the forge types the author as a user, not an app. */
  person: boolean;
  /** The author's association with the repository. */
  association: string;
  state: string;
  /** The commit the review was submitted against. */
  commit: string;
}

/** What the forge says of one pull request, at one head. */
export interface ForgeFacts {
  number: number;
  head: string;
  draft: boolean;
  /** `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string;
  /** The forge's merge state (`CLEAN`, `BLOCKED`, `BEHIND`, …). */
  mergeState: string;
  /** Whether its base requires a merge queue, whose own rules then decide. */
  mergeQueue: boolean;
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` or `null`. */
  reviewDecision: string | null;
  /** Its author's association with the repository. */
  authorAssociation: string;
  labels: string[];
  /** A truncated label connection cannot prove a pull request is outside the dispatch scope. */
  labelsPartial?: boolean;
  unresolvedThreads: number;
  checks: HeadCheck[];
  reviews: HeadReview[];
  /** The reviewers and teams a review is requested from. */
  requested: string[];
  /** The merge methods the repository allows. */
  methods: { squash: boolean; merge: boolean; rebase: boolean };
  /** Why part of it did not read (a connection longer than one page); `null` when it read whole. */
  partial: string | null;
}

/** What the dispatcher and the drive know of the pull request beside the forge. */
export interface MergeFacts extends ForgeFacts {
  /** The repository's slug, `owner/name`. */
  slug: string;
  /** Its drive ledger stopped converged. */
  converged: boolean;
  /** The head the drive verified. */
  verifiedSha: string;
  /** A person's hold label stands the dispatcher down from it. */
  held: boolean;
}

/** The repository's rules the predicate applies. */
export interface ReadyRules {
  /** The reviewer app whose check run witnesses a review; `null` where the repository names none. */
  reviewerApp: string | null;
  /** The reviewer's posting check, by name. */
  reviewerCheck: RegExp;
  /** The CI hold label, under which required checks fail on purpose; `null` where none is configured. */
  ciHoldLabel: string | null;
}

/** One Ready condition, met or not, with the fact behind it. */
export interface ReadyCondition {
  name: string;
  /** `null` when it was not read. */
  met: boolean | null;
  fact: string;
}

/** The predicate's answer for one pull request. */
export interface Readiness {
  place: Placement;
  /** Its lane, for a pull request in Ready to merge. */
  lane: Lane | null;
  /** What the card says, in the board's own words. */
  says: string;
  waitsOn: WaitsOn;
  conditions: ReadyCondition[];
  /** The checks failing on the head, by name: text the forge's apps wrote. */
  failing: string[];
  /** The reviewers or teams a review is requested from, as requested. */
  requested: string[];
  /** For merge now: the command pinned to the verified head; `null` when withheld. */
  command: string | null;
  /** Why the command is withheld; `null` when it is built or not wanted. */
  withheld: string | null;
}

/**
 * A reviewer check pattern as a case-insensitive `RegExp`, its POSIX
 * character classes (`[[:space:]]`, written for the shell's dialect) read as
 * JavaScript's.
 */
export function checkPattern(pattern: string): RegExp {
  return new RegExp(
    pattern
      .replaceAll("[[:space:]]", "\\s")
      .replaceAll("[[:digit:]]", "\\d")
      .replaceAll("[[:alpha:]]", "[A-Za-z]")
      .replaceAll("[[:alnum:]]", "[A-Za-z0-9]"),
    "i",
  );
}

/** The associations the forge gives the repository's own authors. */
const OWN = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Merge states under which branch protection lets it merge now. */
const MERGES_NOW = new Set(["CLEAN", "HAS_HOOKS"]);

/** Whether the timestamps prove that one ordinary attempt superseded another. */
function supersedes(a: HeadCheck, b: HeadCheck): boolean {
  const startA = Date.parse(a.startedAt ?? "");
  const startB = Date.parse(b.startedAt ?? "");
  if (!Number.isFinite(startA) || !Number.isFinite(startB)) return false;
  if (startA !== startB) return startA > startB;
  const endA = Date.parse(a.completedAt ?? "");
  const endB = Date.parse(b.completedAt ?? "");
  return Number.isFinite(endA) && Number.isFinite(endB) && endA > endB;
}

/** Latest ordinary checks by name and posting app; unread order retains every possible blocker. */
function latestChecks(facts: ForgeFacts, rules: ReadyRules): HeadCheck[] {
  return facts.checks.filter((check) => {
    // The review witness has its own stricter ordering by attempt id.
    if (
      rules.reviewerApp !== null &&
      check.app === rules.reviewerApp &&
      rules.reviewerCheck.test(check.name)
    )
      return true;
    return !facts.checks.some(
      (other) =>
        other.name === check.name &&
        other.app === check.app &&
        supersedes(other, check),
    );
  });
}

/** The latest attempt per reviewer check name; unread attempt order withholds the witness. */
function reviewerRuns(facts: ForgeFacts, rules: ReadyRules): HeadCheck[] {
  const grouped = new Map<string, HeadCheck[]>();
  for (const check of facts.checks) {
    if (
      check.app !== rules.reviewerApp ||
      !rules.reviewerCheck.test(check.name)
    )
      continue;
    const attempts = grouped.get(check.name) ?? [];
    attempts.push(check);
    grouped.set(check.name, attempts);
  }
  const latest: HeadCheck[] = [];
  for (const attempts of grouped.values()) {
    if (attempts.length > 1 && attempts.some((r) => r.id == null)) return [];
    attempts.sort((a, b) => (b.id ?? -1) - (a.id ?? -1));
    latest.push(...attempts.slice(0, 1));
  }
  return latest;
}

/** Whether a person of the repository's own approved the head: an approval from any other account is no witness. */
function approvedHere(facts: ForgeFacts): boolean {
  return facts.reviews.some(
    (r) =>
      r.person &&
      OWN.has(r.association) &&
      r.state === "APPROVED" &&
      r.commit === facts.head,
  );
}

/** The witness of a review of the head: the reviewer app's check, else a person's approval. */
function witness(
  facts: ForgeFacts,
  rules: ReadyRules,
): { met: boolean; fact: string; byApp: boolean } {
  if (rules.reviewerApp === null)
    return approvedHere(facts)
      ? { met: true, fact: "a person approved this head", byApp: false }
      : {
          met: false,
          fact: "no reviewer app is named and no person approved this head",
          byApp: false,
        };
  const runs = reviewerRuns(facts, rules);
  if (runs.length === 0)
    return {
      met: false,
      fact: `${rules.reviewerApp} posted no review check on this head`,
      byApp: true,
    };
  const met = runs.every(
    (run) => run.state === "success" || run.state === "neutral",
  );
  return {
    met,
    fact: runs
      .map(
        (run) =>
          `${rules.reviewerApp}'s ${run.name} check on this head is ${run.state}`,
      )
      .join("; "),
    byApp: true,
  };
}

/** The checks failing on the head, the reviewer's own left to the witness. */
function failingChecks(facts: ForgeFacts, rules: ReadyRules): string[] {
  return facts.checks
    .filter(
      (c) =>
        c.state === "failure" &&
        !(
          rules.reviewerApp !== null &&
          c.app === rules.reviewerApp &&
          rules.reviewerCheck.test(c.name)
        ),
    )
    .map((c) => c.name);
}

/** What every row and condition reads of one pull request. */
interface Read {
  facts: MergeFacts;
  seen: ReturnType<typeof witness>;
  ciHeld: boolean;
  failing: string[];
  /** The forge's merge state, `null` where a merge queue decides instead. */
  state: string | null;
  own: boolean;
  approved: boolean;
}

/** Whether branch protection lets it merge now: `null` while the forge is computing. */
function protection(r: Read): boolean | null {
  if (r.state === null || MERGES_NOW.has(r.state)) return true;
  return r.state === "UNKNOWN" ? null : false;
}

/** Who wrote it, and who approved it. */
function authorFact(r: Read): string {
  if (r.own) return `author is ${r.facts.authorAssociation}`;
  return r.approved
    ? "outside author, approved by a person"
    : `outside author (${r.facts.authorAssociation})`;
}

/** Which hold label stands, if any. */
function holdFact(r: Read): string {
  if (r.facts.held) return "a person's hold label";
  return r.ciHeld ? "the CI hold label" : "no hold label";
}

/** The Ready conditions, each a function of the read, in the design's order. */
const CONDITIONS: Array<(r: Read) => ReadyCondition> = [
  ({ facts }) => ({
    name: "converged",
    met: facts.converged,
    fact: facts.converged
      ? "its drive stopped converged"
      : "its drive has not converged",
  }),
  ({ facts }) => ({
    name: "verified head",
    met: facts.head === facts.verifiedSha,
    fact: `head ${facts.head.slice(0, 7)}, verified ${facts.verifiedSha.slice(0, 7) || "none"}`,
  }),
  ({ seen }) => ({ name: "review witnessed", met: seen.met, fact: seen.fact }),
  ({ facts }) => ({
    name: "mergeable",
    met: facts.mergeable === "UNKNOWN" ? null : facts.mergeable === "MERGEABLE",
    fact: `mergeable ${facts.mergeable}`,
  }),
  ({ facts }) => ({
    name: "not a draft",
    met: !facts.draft,
    fact: facts.draft ? "a draft" : "ready for review",
  }),
  ({ facts }) => ({
    name: "no unresolved thread",
    met: facts.unresolvedThreads === 0,
    fact: `${facts.unresolvedThreads} unresolved`,
  }),
  (r) => ({
    name: "protection lets it merge",
    met: protection(r),
    fact:
      r.state === null
        ? "its base requires a merge queue"
        : `merge state ${r.state}`,
  }),
  (r) => ({
    name: "own author or approved",
    met: r.own || r.approved,
    fact: authorFact(r),
  }),
  (r) => ({
    name: "not held",
    met: !r.facts.held && !r.ciHeld,
    fact: holdFact(r),
  }),
];

/** The strict forms a merge command's values must pass. */
const FORMS = {
  number: (n: number) => Number.isSafeInteger(n) && n > 0,
  slug: (s: string) => /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(s),
  sha: (s: string) => /^[0-9a-f]{40}$/.test(s),
};

/** The merge command pinned to the verified head, or which value withheld it. */
export function mergeCommand(facts: MergeFacts): {
  command: string | null;
  withheld: string | null;
} {
  if (!FORMS.number(facts.number))
    return { command: null, withheld: "the pull request's number" };
  if (!FORMS.slug(facts.slug))
    return { command: null, withheld: "the repository's name" };
  if (!FORMS.sha(facts.verifiedSha))
    return { command: null, withheld: "the verified head" };
  const base = `gh pr merge ${facts.number} --repo ${facts.slug} --match-head-commit ${facts.verifiedSha}`;
  if (facts.mergeQueue) return { command: base, withheld: null };
  const method = (["squash", "merge", "rebase"] as const).find(
    (m) => facts.methods[m],
  );
  return method === undefined
    ? {
        command: null,
        withheld: "the merge method: the repository allows none",
      }
    : { command: `${base} --${method}`, withheld: null };
}

const person = (act: Act): WaitsOn => ({ kind: "person", act });
const waiting = (what: string): WaitsOn => ({ kind: "waiting", for: what });

/** A merge command, or which value withheld it. */
type Command = { command: string | null; withheld: string | null };

/** One row's placement: where, what settles it, what the card says, its lane in Ready to merge, and for merge now its command. */
type Row = [Placement, WaitsOn, string, Lane?, Command?];

/** Whether an approval is still owed: by the forge, or because the witness or the author asks for one. */
function approvalOwed(r: Read): { byForge: boolean; byRule: boolean } {
  const required = r.facts.reviewDecision === "REVIEW_REQUIRED";
  return {
    // A merge queue's base is placed by the queue, but a required review it reports is still owed.
    byForge: required && (r.state === "BLOCKED" || r.facts.mergeQueue),
    byRule: !r.approved && (!r.seen.byApp || !r.own),
  };
}

const UNREAD_RULES =
  "the board has not read the repository's other protection rules (signatures, deployments), and the forge may ask for more once an approval is given";

/** The rows before any person's act: what the drive and the forge must settle first. */
const SETTLED_FIRST: Array<(r: Read) => Row | null> = [
  ({ facts }) =>
    facts.converged
      ? null
      : ["stay", waiting("its drive"), "its drive has not converged"],
  ({ facts }) =>
    facts.partial === null
      ? null
      : [
          "stay",
          waiting("the next read"),
          `not read in full: ${facts.partial}; open the pull request`,
        ],
  ({ facts }) =>
    facts.head === facts.verifiedSha
      ? null
      : [
          "coming",
          waiting("a re-drive"),
          "its head moved past the head the drive verified, so the dispatcher re-drives it",
        ],
  ({ facts }) =>
    facts.mergeable !== "CONFLICTING"
      ? null
      : [
          "coming",
          waiting("a re-drive"),
          "it conflicts with its base, so the dispatcher re-drives it",
        ],
];

/** The rows that wait on a person's act other than an approval, then on what is still running. */
const BLOCKERS: Array<(r: Read) => Row | null> = [
  ({ facts }) =>
    facts.draft
      ? [
          "needs-you",
          person("mark-ready"),
          "converged as a draft: marking it ready summons the reviewers that skip drafts",
        ]
      : null,
  ({ ciHeld }) =>
    ciHeld
      ? [
          "needs-you",
          person("remove-label"),
          "held by the CI hold label, never failing: the drive removes it as it converges, so it was added again after; removing it runs the checks again on the same head",
        ]
      : null,
  ({ facts }) =>
    facts.held
      ? [
          "needs-you",
          person("remove-label"),
          "a person's hold label stands the dispatcher down from it",
        ]
      : null,
  ({ facts }) =>
    facts.unresolvedThreads > 0
      ? [
          "needs-you",
          person("answer"),
          `${facts.unresolvedThreads} review thread(s) opened after the drive converged: answer them, or re-arm the drive`,
        ]
      : null,
  ({ seen }) =>
    seen.byApp && !seen.met
      ? [
          "needs-you",
          person("re-arm"),
          `the review the ledger reports is not witnessed on this head: ${seen.fact}`,
        ]
      : null,
  ({ facts }) => {
    if (facts.reviewDecision !== "CHANGES_REQUESTED") return null;
    const who = facts.reviews
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => r.author);
    const by = who.length === 0 ? "" : ` by ${who.join(", ")}`;
    return [
      "needs-you",
      person("re-arm"),
      `changes were requested${by}: that reviewer re-reviews, or the drive is re-armed to address them`,
    ];
  },
  ({ facts, failing, state }) =>
    failing.length > 0 &&
    (state === null ||
      state === "BLOCKED" ||
      state === "UNSTABLE" ||
      // A stale CLEAN merge state cannot override a current required failure.
      facts.checks.some(
        (c) => c.required && c.state === "failure" && failing.includes(c.name),
      ))
      ? [
          "needs-you",
          person("re-run-check"),
          `a check failed after the drive converged (${failing.join(", ")}): re-run it, or re-arm the drive`,
        ]
      : null,
  ({ facts }) =>
    facts.checks.some((c) => c.required && c.state === "pending")
      ? ["stay", waiting("the checks running"), "the checks are still running"]
      : null,
  ({ facts, state }) =>
    state === "UNKNOWN" || facts.mergeable === "UNKNOWN"
      ? [
          "stay",
          waiting("the forge"),
          "not read: the forge is still computing whether it can merge",
        ]
      : null,
];

/** The lanes of Ready to merge before merge now, and the merge the forge blocks for a reason the read cannot tell. */
const LANE_ROWS: Array<(r: Read) => Row | null> = [
  (r) => {
    if (r.state !== "BEHIND") return null;
    const owed = approvalOwed(r);
    const still =
      owed.byForge || owed.byRule ? "; an approval is still owed" : "";
    return [
      "ready",
      person("update-branch"),
      `the repository requires an up-to-date branch: updating moves its head, which costs a re-drive (a review round and a CI run)${still}`,
      "update-next",
    ];
  },
  (r) => {
    const owed = approvalOwed(r);
    if (!owed.byForge && !(owed.byRule && protection(r) === true)) return null;
    const requested = r.facts.requested;
    return requested.length > 0
      ? [
          "ready",
          person("approve"),
          `waits on an approval; requested from ${requested.join(", ")}; ${UNREAD_RULES}`,
          "approve-first",
        ]
      : [
          "ready",
          person("request-review"),
          `needs a review and approval from someone other than its author, and nobody is asked; ${UNREAD_RULES}`,
          "approve-first",
        ];
  },
  (r) =>
    protection(r) === true
      ? null
      : [
          "needs-you",
          person("open-pr"),
          `the forge blocks the merge (${r.facts.mergeState}) on a rule the board cannot tell, such as signed commits or a deployment: open the pull request`,
        ],
];

/** The placement table's rows, first match: every blocker before the approval rows. */
const ROWS = [...SETTLED_FIRST, ...BLOCKERS, ...LANE_ROWS];

const NO_COMMAND: Command = { command: null, withheld: null };

/** Merge now: every row passed. */
function mergeNow(
  facts: MergeFacts,
): Row & { 4: ReturnType<typeof mergeCommand> } {
  const built = mergeCommand(facts);
  const says =
    built.command === null
      ? `converged, witnessed and mergeable; the merge command is withheld: ${built.withheld} does not pass its form`
      : "converged, witnessed and mergeable at the verified head";
  return ["ready", person("merge"), says, "merge-now", built];
}

/** What every row and condition reads, worked out once. */
function readOf(facts: MergeFacts, rules: ReadyRules): Read {
  facts = { ...facts, checks: latestChecks(facts, rules) };
  return {
    facts,
    seen: witness(facts, rules),
    ciHeld:
      rules.ciHoldLabel !== null && facts.labels.includes(rules.ciHoldLabel),
    failing: failingChecks(facts, rules),
    state: facts.mergeQueue ? null : facts.mergeState,
    own: OWN.has(facts.authorAssociation),
    approved: approvedHere(facts),
  };
}

/** Place one converged pull request (design/dispatch-board.md § Ready, exactly). */
export function readiness(facts: MergeFacts, rules: ReadyRules): Readiness {
  const r = readOf(facts, rules);
  const matched = ROWS.map((row) => row(r)).find((row) => row !== null);
  const [place, waitsOn, says, lane = null, built = NO_COMMAND] =
    matched ?? mergeNow(facts);
  return {
    place,
    lane,
    says,
    waitsOn,
    ...built,
    conditions: CONDITIONS.map((condition) => condition(r)),
    failing: r.failing,
    requested: facts.requested,
  };
}

/** A card of Ready to merge, for ordering within a lane. */
export interface Ordered {
  number: number;
  lane: Lane;
  /** When it entered its lane, or the best the records say. */
  since: string;
  /** The pull requests that wait behind it in a serialized area. */
  unblocks: number[];
}

/** The order within Ready to merge: by lane, then those that unblock others, then the longest wait first. */
export function readyOrder<T extends Ordered>(cards: readonly T[]): T[] {
  return [...cards].sort(
    (a, b) =>
      LANES.indexOf(a.lane) - LANES.indexOf(b.lane) ||
      Number(b.unblocks.length > 0) - Number(a.unblocks.length > 0) ||
      a.since.localeCompare(b.since) ||
      a.number - b.number,
  );
}
