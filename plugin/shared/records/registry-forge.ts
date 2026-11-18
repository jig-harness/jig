/**
 * The records registry's kinds on the forge and the tracker
 * (`registry.ts`): comments, bodies and labels on a pull request, and
 * fields, issues and comments on a tracker item. The Jig Protocol's chapters
 * on hidden comment markers and on the follow-up claim are generated from
 * these entries (`plugin/protocol/`).
 */
import { plain, type RecordKind } from "./registry-kind.ts";

/** A pull request's number: the key of a record about one pull request. */
const PR_NUMBER = /^[1-9]\d*$/;

/** A forge claim's key (`forge-claims.ts`): what is claimed on the pull request its comment is on. */
const TAKEOVER_KEY = /^takeover:\d+$/;
/** A follow-up claim's key; one written before claims (version 1) is its pull request's number. */
const FOLLOWUP_KEY = /^(?:followup|[1-9]\d*)$/;
/** A launch claim's key: a launch of the drive of the pull request it is on; its generation is the attempt. */
const LAUNCH_KEY = /^drive$/;
/** A claim marker's key: the item the comment is on. */
const CLAIM_MARKER_KEY = /^claim$/;
const MERGE_READY_KEY = /^merge-ready:[0-9a-f]{7,64}$/;
/** A sent answer's key: the parked item it answers, on the pull request its comment is on. */
const ANSWER_KEY = /^answer:\S+$/;

const DRIVE = "skills/drive-pr/scripts/";
const STATE = `${DRIVE}lib/state/`;
const RRC = "skills/resolve-review-comments/scripts/";
const REFLECT = "skills/reflect/scripts/";

export const FORGE: RecordKind[] = [
  // The ledger mirrors optional ciActions without extending the control-event vocabulary.
  {
    name: "drive-ledger",
    medium: "forge",
    owner: `${STATE}ledger-mirror.ts`,
    at: "one comment on the pull request",
    markers: ["drive-pr-ledger", "drive-pr-ledger-data"],
    version: 2,
    key: PR_NUMBER,
    meaning:
      "The drive's resumable state, mirrored onto the pull request at each round boundary, park and takeover: who drives it, its round, what is parked and how the drive stands, so a drive started in another clone or on another machine resumes where the last one left off. Only a driver writes it; of two ledgers the earliest trusted comment is the ledger.",
  },
  {
    name: "drive-takeover-claim",
    medium: "forge",
    owner: `${STATE}ledger-forge.ts`,
    at: "a claim comment on the pull request per takeover (`forge-claims.ts`)",
    markers: ["drive-pr-takeover-claim", "drive-pr-takeover-claim-data"],
    version: 1,
    key: TAKEOVER_KEY,
    meaning:
      "A driver's claim to take a drive over from another clone's stopped driver, one per ledger generation: of the claims on one generation the earliest trusted one wins, and the others stand down.",
  },
  {
    name: "dispatch-followup",
    medium: "forge",
    owner: "shared/records/launch-claims.ts",
    at: "a claim comment on the merged pull request (`forge-claims.ts`), a shared record (`shared.ts`)",
    markers: ["jig-dispatch-followup", "jig-dispatch-followup-data"],
    version: 2,
    key: FOLLOWUP_KEY,
    meaning:
      "The claim on a merged pull request's one follow-up: which run took it, a dispatcher's tick or a person's, and once it ended, its outcome. A follow-up posts or reads it before it acts, and stops when an earlier trusted marker holds the follow-up.",
  },
  {
    name: "dispatch-launch-claim",
    medium: "forge",
    owner: "shared/records/launch-claims.ts",
    at: "a claim comment on the pull request per drive launch (`forge-claims.ts`), a shared record (`shared.ts`)",
    markers: ["jig-dispatch-launch-claim", "jig-dispatch-launch-claim-data"],
    version: 1,
    key: LAUNCH_KEY,
    meaning:
      "A dispatching host's claim of one launch of the pull request's drive (a re-arm, a re-drive, an arm or a takeover), and how that launch ended, so no other host dispatching the repository launches it twice.",
  },
  {
    name: "drive-merge-ready",
    medium: "forge",
    owner: `${DRIVE}lib/announce.ts`,
    at: "a claim comment on the pull request per verified head (`forge-claims.ts`)",
    markers: ["drive-pr-merge-ready", "drive-pr-merge-ready-data"],
    version: 1,
    key: MERGE_READY_KEY,
    meaning:
      "A driver's announcement that one head of the pull request is converged, green, mergeable and clean, posted only while that holds and withdrawn when it stops holding.",
  },
  {
    name: "summary-answer",
    medium: "forge",
    owner: `${DRIVE}answer-summary-finding.ts`,
    at: "a comment on the pull request answering a summary finding",
    markers: ["drive-pr-addressed"],
    version: 0,
    meaning:
      "The drive's answer to a review finding the reviewer could not anchor to a line of the diff, one marker per finding with its fingerprint. A finding whose marker a trusted author wrote counts as answered, and is not answered again.",
  },
  {
    name: "thread-reply",
    medium: "forge",
    owner: `${RRC}reply-to-thread.ts`,
    at: "a reply on a review thread, its last line a marker where it has one (and the repository's own `reply.marker` on a declined finding)",
    markers: [
      "triage-thread:leave-open",
      "reply-to-thread:no-outcome",
      "reply-to-thread:provisional",
    ],
    version: 0,
    meaning:
      "A reply on a review thread. Its last-line marker says the thread was answered and is deliberately left unresolved, the reply asks a question and carries no outcome, or its outcome is provisional and a person may reverse it. A marker counts only as the reply's last line, and does not prove who wrote it.",
  },
  {
    name: "deferred-section",
    medium: "forge",
    owner: `${RRC}lib/pr-body.ts`,
    at: "the pull request body, between its two markers, one entry per deferred finding",
    markers: ["jig-deferred", "deferred-entry"],
    version: 0,
    meaning:
      "The findings a pull request deferred, one entry each in its body, which are filed as tracker issues once it merges or closes. A person's text outside the markers is never touched.",
  },
  plain(
    "forge",
    "scanner-finding-reply",
    `${RRC.replace("scripts/", "")}SKILL.md`,
    "a comment on the pull request answering a scanner's finding, one `scanner-finding: <fingerprint>` marker line per finding, written by the session the skill instructs",
    0,
    "An answer to a code scanner's finding, one marker line per finding, which a later answer to the same finding reuses rather than posting again.",
  ),
  plain(
    "forge",
    "ci-hold-label",
    `${DRIVE}ci-hold.ts`,
    "the label `ci.hold_label` names, on the pull request",
    0,
    "The label the repository's workflows honour by skipping expensive jobs on intermediate pushes. The drive removes it once review converges, and adopts one it did not add; it is a setting of CI's cost, never a signal to the drive.",
  ),
  {
    name: "drive-answer",
    medium: "forge",
    owner: "shared/decisions/answer-record.ts",
    at: "a comment on the pull request answering one parked item, written by `jig send` or the dispatch dashboard's Send, or on a tracker item answering a pickup's decision, written by `jig send`",
    markers: ["jig-send-answer"],
    version: 1,
    key: ANSWER_KEY,
    meaning:
      "A person's answer to one parked question, written by `jig send`: the re-arm reads its `answer <key>:` line from a trusted author and hands the answer to the next pass. Each person's latest answer counts.",
  },
  plain(
    "forge",
    "dispatch-command-label",
    "dispatch/lib/requests.ts",
    "a command label on the pull request (`jig:drive`, `jig:hold`), which a person writes by hand or with `jig send`",
    0,
    "A person's command to the dispatcher on a pull request: `drive` arms a drive where there is no ledger, `rearm` re-arms one, and `hold` keeps every stage off the pull request.",
  ),
  plain(
    "forge",
    "dispatch-state-label",
    "dispatch/lib/actions/labels.ts",
    "a state label on the pull request (`jig:driving`, `jig:parked`, …)",
    0,
    "Where a managed pull request stands, as the dispatcher derives it from the ledger at each tick (`driving`, `parked`, …), for people and boards to filter by; never read to decide what to start.",
  ),
  {
    name: "ai-review-summary",
    medium: "forge",
    owner: `${DRIVE}lib/overlay.ts`,
    foreign: "the repository's AI reviewer",
    at: "the reviewer's sticky comment, and the reviewed commit and any skip notice marked in it (`review.sticky_marker`, `review.reviewed_sha_marker`, `review.skip_notice_marker`)",
    markers: ["ai-code-review"],
    version: 0,
    meaning:
      "The AI reviewer's summary comment, with the commit it reviewed and any notice that it skipped one, from which the drive learns whether the head was reviewed and what the review left open. The markers are the repository's configuration; the one listed is the default.",
  },
  {
    name: "ai-review-round",
    medium: "forge",
    owner: `${DRIVE}summary-findings.ts`,
    foreign: "the repository's AI reviewer",
    at: "a marker in the reviewer's comments naming its round, and its backlog",
    markers: ["ai-review-round", "ai-review-backlog"],
    version: 0,
    meaning:
      "The review round a reviewer's comment belongs to, and the findings the reviewer held out of its threads, which the drive counts as summary findings to answer.",
  },
  {
    name: "coderabbit-comment",
    medium: "forge",
    owner: `${DRIVE}lib/bot-confirmation.ts`,
    foreign: "CodeRabbit",
    at: "the markers in CodeRabbit's comments",
    markers: [
      "coderabbit-ai-generated:v1",
      "coderabbit-skip-review-comment-follow-up",
    ],
    version: 0,
    meaning:
      "A review bot's follow-up on an answered thread that carries no new finding (a confirmation after a push, or an acknowledgement of a reply), which the drive lets pass without an answer.",
  },
  {
    name: "coderabbit-review-body",
    medium: "forge",
    owner: `${DRIVE}lib/review-body.ts`,
    foreign: "CodeRabbit",
    at: "the sections of findings in the body of CodeRabbit's pull-request reviews, each entry marked with its id",
    markers: ["cr-comment:v"],
    version: 0,
    meaning:
      "A finding the reviewer put only in the body of its review, never in a thread, marked with its id, which the drive reads as a summary finding to answer.",
  },
];

export const TRACKER: RecordKind[] = [
  {
    name: "tracker-footprint",
    medium: "tracker",
    owner: "shared/footprint.ts",
    at: "a marked comment on a tracker item, read from trusted authors only",
    markers: ["jig:footprint"],
    version: 1,
    key: /^(?:#[1-9]\d*|[A-Za-z][A-Za-z0-9]*-[1-9]\d*)$/,
    meaning:
      "An item's predicted repository paths and change areas, its source and base commit. The running pickup's newest prediction stands; otherwise the newest trusted record stands, with labels or unknown when absent.",
  },
  {
    name: "do-item-pr-association",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/linked-pr.ts",
    foreign: "the session following the do-item skill",
    at: "the opening comment on an item",
    markers: ["do-item-pr"],
    version: 0,
    meaning:
      "Binds a tracker item to the exact pull request opened for it, where no issue-link line is required, so the item's parent roll-up can tell whether that pull request merged. A link in any other comment is no evidence.",
  },
  plain(
    "tracker",
    "tracker-claim",
    "skills/do-item/scripts/lib/claim.ts",
    "the item's assignee and its in-progress state",
    0,
    "A pickup's claim of an item: assigned to the claimant and moved to its in-progress state. A claim refuses an item someone else holds.",
  ),
  plain(
    "tracker",
    "dispatch-pickup-assignment",
    "dispatch/lib/requests.ts",
    "the item assigned to the factory identity in a dispatch state, which a person writes by hand or with `jig send`",
    0,
    "A person's request that the dispatcher pick an item up: the item assigned to the factory identity in a dispatch state, started only when that person can write to the repository.",
  ),
  plain(
    "tracker",
    "dispatch-pool-readiness",
    "dispatch/lib/sources/ready-pool.ts",
    "an unassigned item a person moved into a ready-pool state, read with who made the move",
    0,
    "An unassigned item moved into a ready-pool state, which the dispatcher picks up as the factory's only when the person who made the move can write to the repository.",
  ),
  plain(
    "tracker",
    "deferred-issue",
    `${RRC}file-deferred.ts`,
    "an issue whose description names the deferred finding",
    0,
    "The tracker issue a deferred finding was filed as; an issue that already names the finding is reused rather than filed again.",
  ),
  {
    name: "deferred-batch",
    medium: "tracker",
    owner: `${RRC}defer-batch.ts`,
    at: "the first line of a batch issue's description",
    markers: ["defer-batch-key"],
    version: 0,
    meaning:
      "The issue that collects one pull request's deferred findings of one type, found by its key so that each finding is appended to it rather than filed alone; of two with one key the oldest wins.",
  },
  {
    name: "tracker-claim-marker",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/claim-marker.ts",
    at: "a comment on an item a claim started, where `do_item.claim_marker` is set",
    markers: ["jig-claim", "jig-claim-data", "jig-claim-outcome"],
    version: 1,
    key: CLAIM_MARKER_KEY,
    meaning:
      "The token a claim posts on an item before it writes the item, naming the claim's attempt, its session, its branch and the claimant, so another tool sees which session holds the item, and of two hosts claiming it at once the earliest marker wins; beside it, each attempt records once how it ended (claimed, released or unresolved), and a marker whose attempt recorded released or unresolved holds nothing.",
  },
  {
    name: "tracker-related",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/tracker/github/related-migration.ts",
    at: "a legacy comment on a GitHub issue relating it to another, read until the migration marks it superseded",
    markers: ["jig:related", "jig:related-superseded"],
    version: 0,
    meaning:
      "A link from one GitHub issue to another, written as a comment before GitHub had related links: read as a link until the migration converts it to GitHub's own and marks it superseded.",
  },
  {
    name: "tracker-attachment",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/tracker/github/attachments.ts",
    at: "a comment on a GitHub issue holding a file attached to it, the file's text or a link to a hosted copy, where GitHub Issues has no file upload",
    markers: ["jig:attachment"],
    version: 0,
    meaning:
      "A file attached to a GitHub issue, its text carried in the comment or a link to a hosted copy. A carried file whose text no longer has the size its marker records reads as changed, never as the file.",
  },
  {
    name: "tracker-blocked",
    medium: "tracker",
    owner: "skills/do-item/scripts/lib/blocked-move.ts",
    at: "a comment on an item the drive-ledger projection moved to blocked, naming its pull request, the stop and the state it left",
    markers: ["jig:blocked"],
    version: 0,
    meaning:
      "That an item was moved to blocked because its pull request's drive stopped, naming the pull request, the stop and the state the item left, so one stop blocks the item once and the item returns only to that state.",
  },
  {
    name: "issue-fields-sweep",
    medium: "tracker",
    owner: "skills/file-issue/scripts/lib/sweep.ts",
    at: "a comment on an issue the weekly sweep found incomplete, naming what it lacks",
    markers: ["jig:issue-fields"],
    version: 0,
    meaning:
      "That the weekly sweep found an issue incomplete, naming the facets it lacks and the retired labels it carries: it moved the issue back to triage, or, where the repository keeps the sweep from moving issues, left it where it is. A run that stopped before the move finds the comment and moves the issue without posting again; where the sweep does not move issues, a later run passes over an issue that carries it.",
  },
  {
    name: "reflection-github-store",
    medium: "tracker",
    owner: `${REFLECT}lib/github/store.ts`,
    at: "an issue per change in the reflection repository, and comments holding its events",
    markers: ["jig-reflection-change", "jig-reflection-events"],
    version: 1,
    meaning:
      "The GitHub reflection store: an issue per change, and comments holding the change's events, read only from authors who can write to the repository.",
  },
  plain(
    "tracker",
    "reflection-escalation",
    `${REFLECT}lib/escalation.ts`,
    "an issue labelled with the finding's class, its owner on one line of its description",
    0,
    "The issue that takes every new finding of a class that keeps recurring for one owner, and asks for a structural fix; it is found by its class's label and its owner's line.",
  ),
  {
    name: "fleet-health-suspicion",
    medium: "tracker",
    owner: `${DRIVE}fleet-health.ts`,
    at: "a comment on an epic",
    markers: ["fleet-health"],
    version: 0,
    meaning:
      "A suspicion the fleet-health sensor raised on an epic, of work that shows ceremony without progress: never a diagnosis, which only a person's comment on the epic makes.",
  },
  {
    name: "epic-acceptance-verdict",
    medium: "tracker",
    owner: `${DRIVE}lib/fleet-health-sources.ts`,
    foreign: "a person accepting an epic",
    at: "a line in a comment on an epic",
    markers: ["epic-acceptance-verdict"],
    version: 0,
    meaning:
      "A person's verdict on an epic, `ACCEPT`, `ACCEPT-WITH-FOLLOWUPS` or `REJECT`, on the comment's last line. The fleet-health sensor counts an epic accepted when its newest verdict from a trusted author accepts it.",
  },
];
