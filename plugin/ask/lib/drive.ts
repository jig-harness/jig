import { derivedNext } from "../../dispatch/lib/next-owner.ts";
/**
 * The `drive` station of a pull request: who drives it, the state of its
 * drive, what that waits on and how its last launch ended, from the records
 * the drive and the dispatcher keep. The pull request and its comments are
 * read once, and the comments shared by the drive ledger, the launch claims,
 * the merge-ready announcements and the answers. The ledger's stop is placed
 * by the dispatcher's own classifier (`dispatch/lib/sources/ledgers.ts`),
 * with the exit named from the drive's terminal-state registry, so a drive's
 * state means here what it means to the tick.
 *
 * Here, this machine's launch records name the account, the session and
 * whether the process runs; elsewhere the forge's launch claims say which
 * host holds a launch and how the last one ended. A drive nobody dispatched
 * is read from its listing in a checkout, with the doctor's verdict and its
 * recovery command, printed and never run.
 */
import {
  DRIVE_EXIT,
  driveExitName,
} from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { stallThresholdMs } from "../../skills/drive-pr/scripts/lib/doctor.ts";
import {
  type Ledger,
  type LedgerSnapshot,
  snapshotFrom,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  inboxPath,
  mailboxDir,
  readInboxMessages,
} from "../../skills/drive-pr/scripts/lib/state/mailbox.ts";
import {
  announcementsOf,
  MERGE_READY,
} from "../../skills/drive-pr/scripts/lib/announce.ts";
import { listedFrom } from "../../shared/records/forge-claims.ts";
import { sharedClaimsFrom } from "../../shared/records/shared-forge.ts";
import {
  current,
  open,
  type ReadClaim,
  type SharedClaim,
  winners,
} from "../../shared/records/shared.ts";
import { settleNoCauseStops } from "../../dispatch/lib/no-cause-stops.ts";
import { settleConflictStops } from "../../dispatch/lib/actions/drive-hold.ts";
import { settlesWithPerson } from "../../dispatch/lib/redrive-settle.ts";
import { isDrive } from "../../dispatch/lib/launches.ts";
import { settleSharedConflictStops } from "../../dispatch/lib/shared-launches.ts";
import { driveClass, lastEnded } from "../../dispatch/lib/log.ts";
import {
  type Classified,
  classifyLedger,
  type ParkReading,
  type PrFacts,
  readsBaseHead,
} from "../../dispatch/lib/sources/ledgers.ts";
import {
  type DriverPresence,
  driverPresence,
} from "../../dispatch/lib/sources/silent-driver.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import {
  type Holder,
  type Last,
  personWait,
  type ThreadEntry,
  type WaitsOn,
} from "./answer.ts";
import { answered, lineParkAct, parkedWait } from "./park-wait.ts";
import {
  type CommentFields,
  commentFields,
  type PullDoc,
  readBranchHead,
  readComments,
} from "./forge.ts";
import { driveRow, type DriveRow } from "./local.ts";
import { takeoverSettled } from "./drive-takeover.ts";
import { convergedWait } from "./merge.ts";
import {
  type AskContext,
  dispatcherReads,
  holdingRecord,
  labelThread,
  lastOfRow,
  pullFor,
  recordHolder,
  type StationAnswer,
} from "./station.ts";
import {
  answerEntries,
  claimEntries,
  commentUrl,
  localLaunchEntries,
  logEntries,
  loggedRecords,
} from "./thread.ts";
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
import type { CiHoldDiagnosis } from "../../skills/drive-pr/scripts/lib/ci-hold-diagnosis.ts";
import type { LogRow } from "../../dispatch/lib/log.ts";

/** What the drive's reads found. */
interface DriveReads {
  pull: PullDoc;
  comments: CommentFields[] | null;
  snapshot: LedgerSnapshot | null;
  claims: SharedClaim[];
  records: ReadRecord[];
  rows: LogRow[];
  row: DriveRow | null;
}

/** The ledger a snapshot holds, or why it holds none this reader reads; `null` reason when it holds none at all. */
function ledgerOf(snapshot: LedgerSnapshot | null): Ledger | string | null {
  if (snapshot === null) return "the pull request's comments were not read";
  const canonical = snapshot.canonical;
  if (canonical === null)
    return snapshot.malformed.length > 0
      ? "its drive ledger comment does not read"
      : null;
  if (canonical.parsed.kind === "ledger") return canonical.parsed.ledger;
  return canonical.parsed.kind === "unknown-version"
    ? `its drive ledger is version ${String(canonical.parsed.version)}, which this reader does not know`
    : `its drive ledger does not read: ${canonical.parsed.reason}`;
}

/** The parks' answers the pull request's conversation holds; a reply on a parked thread is not read here. */
function parkReading(
  ledger: Ledger,
  comments: readonly CommentFields[] | null,
): ParkReading {
  if (comments === null)
    return { unreadable: "the pull request's comments, which did not read" };
  const waiting = ledger.parked.filter((p) => !answered(p.key, p.at, comments));
  return {
    answered: ledger.parked.length - waiting.length,
    waiting: waiting.map((p) => `${p.kind} ${p.key}`),
  };
}

/** The state of a drive in its own words: `running`, the registry's name of its stop, or why neither. */
function stateOf(
  ledger: Ledger | string | null,
  pull: PullDoc,
  row: DriveRow | null,
): { state: string; detail: string } {
  const closed =
    pull.state === "MERGED"
      ? { state: "merged", detail: `merged ${pull.mergedAt ?? ""}`.trim() }
      : pull.state === "CLOSED"
        ? { state: "closed", detail: "the pull request is closed" }
        : null;
  if (ledger === null)
    return (
      closed ??
      (row?.lock === "live"
        ? {
            state: "running",
            detail: "a driver holds its lock; it has written no ledger yet",
          }
        : {
            state: "not driven",
            detail: "no drive ledger on the pull request",
          })
    );
  if (typeof ledger === "string")
    return closed ?? { state: "unknown", detail: ledger };
  const d = ledger.driver;
  const at = `round ${ledger.round}, ledger written ${d.heartbeat}`;
  if (closed !== null)
    return { ...closed, detail: `${closed.detail}; the drive's ${at}` };
  if (d.state === "running") return runningState(d, at);
  return stoppedState(d, at);
}

function runningState(
  d: Ledger["driver"],
  at: string,
): { state: string; detail: string } {
  return {
    state: "running",
    detail:
      d.personStop === undefined
        ? at
        : `${at}; stop requested by a person: ${d.personStop.reason || "operator stop"}; termination is not yet recorded`,
  };
}

function stoppedState(
  d: Ledger["driver"],
  at: string,
): { state: string; detail: string } {
  if (d.personStop !== undefined)
    return {
      state: "stopped by a person",
      detail: `${d.personStop.reason || "operator stop"}; ${at}`,
    };
  if (d.exit === undefined)
    return {
      state: "stopped with no recorded cause",
      detail: `stopped with no recorded cause; ${at}`,
    };
  const name = driveExitName(d.exit);
  return {
    state: name ?? `exit ${d.exit}`,
    detail: `stopped exit ${d.exit}; ${at}`,
  };
}

/** Why a stop on a conflict, a stall or a spent CI-repair budget is a person's to settle, when this machine or another host already re-drove it for the change it shows now; `null` otherwise. */
function conflictSettled(
  placed: Classified,
  ledger: Ledger,
  r: DriveReads,
  host: string | null,
): string | null {
  if (
    placed.class !== "stale" ||
    placed.stale === undefined ||
    !settlesWithPerson(placed.stale)
  )
    return null;
  const own = settleConflictStops(
    [
      {
        number: r.pull.number,
        url: r.pull.url,
        title: r.pull.title,
        head: r.pull.head,
        class: placed.class,
        why: placed.why,
        stale: placed.stale,
        evidence: {
          generation: ledger.generation,
          exit: ledger.driver.exit ?? null,
          heartbeat: ledger.driver.heartbeat,
          mergeable: r.pull.mergeable ?? null,
        },
      },
    ],
    r.records,
  );
  // Another host's ended re-drive settles it as the dispatcher's tick does; a machine whose own name is unknown holds no claims of its own to tell apart.
  const [settled] = settleSharedConflictStops(
    own,
    new Map([[r.pull.number, { ok: true, value: r.claims }]]),
    host ?? "",
  );
  return settled?.class === "needs-person" ? settled.why : null;
}

/** A stall bound to its tree is re-driven only there, and whether an open workspace holds it is the dispatcher's read of its runtime, not this one's. */
function staleWhy(placed: { why: string; stale?: { tree?: unknown } }): string {
  return placed.stale?.tree === undefined
    ? placed.why
    : `${placed.why}; the dispatcher refuses it, and a person recovers the work, where no open workspace on its host holds that tree`;
}

/** What the drive waits on, from the class the dispatcher's classifier places its ledger in. */
function waitsOnOf(
  ledger: Ledger,
  r: DriveReads,
  ctx: AskContext,
  held: boolean,
  base: PrFacts["base"],
  merge: WaitsOn,
): WaitsOn {
  const classification = classifyLedger(
    ledger,
    Date.now(),
    stallThresholdMs(),
    parkReading(ledger, r.comments),
    {
      head: r.pull.head,
      mergeable: r.pull.mergeable,
      ...(base === undefined ? {} : { base }),
    },
  );
  const placed =
    settleNoCauseStops(
      [
        {
          number: r.pull.number,
          url: r.pull.url,
          title: r.pull.title,
          head: r.pull.head,
          ...classification,
          evidence: {
            generation: ledger.generation,
            exit: ledger.driver.exit ?? null,
            heartbeat: ledger.driver.heartbeat,
            noCause:
              ledger.driver.state === "stopped" &&
              ledger.driver.exit === undefined &&
              ledger.driver.personStop === undefined,
            legacyNoCause: ledger.driver.recoveryVersion === undefined,
          },
        },
      ],
      r.records,
      new Map([[r.pull.number, { ok: true, value: r.claims }]]),
      Date.now(),
    )[0] ?? classification;
  const settled = conflictSettled(placed, ledger, r, ctx.host);
  if (settled !== null) return personWait("re-arm", settled);
  // A dispatcher re-arms what settles by itself: this machine's, or one whose launch claims are on the pull request.
  const dispatched = ctx.dispatches || current(r.claims) !== null;
  const rearm = (why: string): WaitsOn =>
    dispatched
      ? { waiting: why }
      : personWait("re-arm", `${why}; no dispatcher is known to re-arm it`);
  // A launch that holds the drive says nothing of a park nobody answered or of a ledger gone silent.
  if (
    held &&
    placed.class !== "parked" &&
    placed.class !== "stale" &&
    placed.class !== "silent"
  )
    return "none";
  switch (placed.class) {
    case "driven":
      return "none";
    case "parked":
      return parkedWait(
        ledger.parked,
        r.comments,
        r.pull.author,
        placed.why,
        lineParkAct(ctx, r.pull.number),
      );
    case "re-armable":
      return rearm(placed.why);
    case "stale":
      return rearm(staleWhy(placed));
    case "refused":
    case "unplaced":
      return { waiting: placed.why };
    case "done":
      return ledger.driver.exit === DRIVE_EXIT.CONVERGED ? merge : "none";
    default:
      return personWait("re-arm", placed.why);
  }
}

/** An open launch claim's launch as the holder: another host's, unless the claim names this one. */
function claimHolder(
  claim: ReadClaim,
  ctx: AskContext,
  generation: number | null,
): Holder {
  const { host, action } = claim.says.value;
  return {
    stage: action,
    host:
      host !== null && host === ctx.host ? "this machine" : (host ?? "unknown"),
    generation,
    process: "unknown",
    why: `launch claim ${claim.id} has no end; whether its process runs is its host's to know`,
  };
}

/** A driver nobody dispatched as the holder: one whose lock this clone holds, or one a fresh running ledger names. */
function driverHolder(
  r: DriveReads,
  ledger: Ledger | null,
  generation: number | null,
): Holder | "none" {
  // A running ledger past the lease window is a silent driver, not a holder: what it waits on says so.
  const beat = Date.parse(ledger?.driver.heartbeat ?? "");
  const driven =
    ledger?.driver.state === "running" &&
    Date.now() - beat <= stallThresholdMs();
  if (sameDriver(r.row, ledger) && r.row?.doctor?.ciHold?.driver === "dead")
    return "none";
  const local =
    r.row?.lock === "live" &&
    (r.row.doctor?.ciHold === undefined ||
      r.row.doctor.ciHold.driver === "alive");
  if (!driven && !local) return "none";
  const doctor = r.row?.doctor;
  const why = local
    ? `a driver nobody dispatched holds its lock in this clone${doctor ? `; the doctor reads it ${doctor.verdict}` : ""}`
    : "the ledger reports a running driver; its process liveness and ownership are unknown";
  const account = r.row?.account ?? null;
  return {
    stage: "drive",
    host: local ? "this machine" : "unknown",
    generation,
    process: local ? "alive" : "unknown",
    why,
    ...(account === null ? {} : { local: { account } }),
  };
}

/** The holder: this machine's launch, else an open launch claim, else a live driver nobody dispatched. */
function holderOf(
  r: DriveReads,
  ledger: Ledger | null,
  ctx: AskContext,
): Holder | "none" {
  const generation = r.row?.generation ?? null;
  const record = holdingRecord(r.records);
  if (record !== null) return recordHolder(record, generation);
  const claim = current(r.claims);
  if (claim !== null && open(claim)) return claimHolder(claim, ctx, generation);
  return driverHolder(r, ledger, generation);
}

/** The last ended launch: the outcome log's row, else the latest claim's end on the forge. */
function lastOf(r: DriveReads): Last | null {
  const row = lastEnded(r.rows, ["rearm", "takeover"]);
  const fromRow = row === null ? null : lastOfRow(row);
  const ended = winners(r.claims)
    .filter((c) => c.says.value.end !== null)
    .sort((a, b) => b.id - a.id)[0];
  const claimed = ended === undefined ? null : lastOfClaim(r, ended);
  // The newer of the two ends: another host may have ended a launch after this machine's last row.
  if (fromRow === null || claimed === null) return fromRow ?? claimed;
  return (Date.parse(claimed.at) || 0) > (Date.parse(fromRow.at) || 0)
    ? claimed
    : fromRow;
}

/** A launch claim's end as the last launch. */
function lastOfClaim(r: DriveReads, ended: ReadClaim): Last | null {
  const end = ended.says.value.end;
  if (end == null) return null;
  if (end.state === "died")
    return {
      class: "died",
      at: end.at,
      reason: end.reason,
      from: "launch claim",
      next: derivedNext("rearm", "died", end.reason),
    };
  const placed =
    end.exit === null
      ? { class: "unknown", reason: "it ended with no exit" }
      : driveClass(
          end.exit,
          r.pull.state === "MERGED"
            ? true
            : r.pull.state === "CLOSED"
              ? false
              : null,
        );
  return {
    class: placed.class,
    at: end.at,
    reason: placed.reason,
    from: "launch claim",
    next: derivedNext("rearm", placed.class, placed.reason),
  };
}

/** The ledger's parked questions and its stop. */
function ledgerEntries(
  ledger: Ledger | null,
  name: string,
  url: string,
): ThreadEntry[] {
  if (ledger === null) return [];
  const record = { kind: "drive-ledger", url };
  const entries: ThreadEntry[] = ledger.parked.map((p) => ({
    at: p.at ?? ledger.driver.heartbeat,
    kind: "question",
    from: name,
    to: "a person",
    // The decision's question, as the drive framed it.
    text: p.reason,
    record,
  }));
  const { state, exit, heartbeat } = ledger.driver;
  if (state === "stopped")
    entries.push({
      at: heartbeat,
      kind: "outcome",
      from: name,
      to: "a person",
      text:
        exit === undefined
          ? "stopped"
          : `stopped exit ${exit} (${driveExitName(exit) ?? "unnamed"})`,
      record,
    });
  return entries;
}

/** The merge-ready announcements among the comments, as the forge-claims rule reads them. */
function announcementEntries(
  comments: readonly CommentFields[],
  r: DriveReads,
  ctx: AskContext,
): ThreadEntry[] {
  const target = { repo: ctx.address.repo, number: r.pull.number };
  const listed = listedFrom(
    MERGE_READY,
    comments.map(rawComment),
    target,
    ctx.login,
  );
  return announcementsOf(listed)
    .filter((a) => a.unreadable === undefined)
    .map((a) => ({
      at: comments.find((c) => c.id === a.id)?.createdAt ?? "",
      kind: "outcome" as const,
      from: ctx.name,
      to: "a person",
      text: `safe to merge at ${a.head}`,
      record: { kind: "drive-merge-ready", url: commentUrl(r.pull.url, a.id) },
    }));
}

/** The thread's entries from the records the answer already read. */
function recordEntries(
  r: DriveReads,
  ledger: Ledger | null,
  ctx: AskContext,
): ThreadEntry[] {
  const { name } = ctx;
  const url = r.pull.url;
  const canonical = r.snapshot?.canonical?.comment;
  const claimed = new Set(
    winners(r.claims).flatMap((c) =>
      c.says.value.record !== null ? [c.says.value.record] : [],
    ),
  );
  const path = ctx.dispatcher === null ? "" : statePath(ctx.dispatcher);
  const comments = r.comments ?? [];
  return [
    ...claimEntries(r.claims, name, url, loggedRecords(r.rows)),
    ...localLaunchEntries(r.records, name, claimed, path),
    ...logEntries(r.rows, name, path),
    ...answerEntries(comments, name, url),
    ...ledgerEntries(
      ledger,
      name,
      canonical === undefined ? url : commentUrl(url, canonical.id),
    ),
    ...announcementEntries(comments, r, ctx),
  ];
}

/** With `--thread`, the thread's own reads: the label requests on the timeline, and this machine's mailbox. */
async function threadReads(
  r: DriveReads,
  ctx: AskContext,
): Promise<ThreadEntry[]> {
  return [
    ...(await labelThread(ctx, r.pull.number, r.pull.url)),
    ...mailboxEntries(r.row, ctx),
  ];
}

/** The directives this machine's mailbox of the drive's working tree holds. */
function mailboxEntries(row: DriveRow | null, ctx: AskContext): ThreadEntry[] {
  const dir =
    row?.mailbox ?? (row?.worktree == null ? null : mailboxDir(row.worktree));
  if (dir === null) {
    ctx.reading.note({
      record: "drive-mailbox",
      read: false,
      local: true,
      detail: "no working tree on this machine holds the drive",
    });
    return [];
  }
  const read = readInboxMessages(dir, ctx.address.key);
  const ok = read.file.kind !== "unreadable";
  ctx.reading.note({
    record: "drive-mailbox",
    read: ok,
    local: true,
    ...(ok ? {} : { detail: `the mailbox ${inboxPath(dir)} does not read` }),
  });
  return read.messages
    .filter((m) => m.kind === "directive")
    .map((m) => ({
      at: m.ts,
      kind: "request" as const,
      from: m.from,
      to: ctx.name,
      text:
        m.kind === "directive"
          ? [m.command, m.target, m.body].filter(Boolean).join(" ")
          : "",
      record: { kind: "drive-mailbox", path: inboxPath(dir) },
      local: true as const,
    }));
}

/** A comment's fields back as the forge's object, for a reader that takes the forge's listing. */
function rawComment(c: CommentFields): Record<string, unknown> {
  return {
    id: c.id,
    body: c.body,
    user: { login: c.login },
    author_association: c.association,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/** The comments of the pull request, read once and shared by every record the answer reads from them. */
async function commentsOf(
  ctx: AskContext,
  pr: number,
): Promise<{ raw: unknown[] | null; comments: CommentFields[] | null }> {
  const { reading, address } = ctx;
  const listed = await readComments(reading, address.repo, pr);
  for (const record of [
    "drive-ledger",
    "dispatch-launch-claim",
    "drive-merge-ready",
  ])
    reading.note({
      record,
      read: listed.ok,
      ...(listed.ok ? {} : { detail: listed.failure.reason }),
    });
  if (!listed.ok) return { raw: null, comments: null };
  return {
    raw: listed.value,
    comments: listed.value
      .map(commentFields)
      .filter((c): c is CommentFields => c !== null),
  };
}

/** One parked question of a drive, and whether a trusted comment after the park answers it. */
export interface ParkedQuestion {
  key: string;
  kind: string;
  /** The decision's question, as the drive framed it. */
  reason: string;
  answered: boolean;
}

/** The ledger's parked questions, each answered or not by the re-arm's rule for a pull-request comment; a reply on a parked thread is not read here. */
export function parkedQuestions(
  ledger: Ledger,
  comments: readonly CommentFields[],
): ParkedQuestion[] {
  return ledger.parked.map((p) => ({
    key: p.key,
    kind: p.kind,
    reason: p.reason,
    answered: answered(p.key, p.at, comments),
  }));
}

/**
 * What one reading of a drive found, beside its answer: for `jig send`,
 * which checks a request against the same records before it writes.
 */
export interface DriveReading {
  answer: StationAnswer;
  /** The pull request; `null` when the key names none. */
  pull: { doc: PullDoc; read: boolean } | null;
  /** Its comments; `null` when they did not read. */
  comments: CommentFields[] | null;
  /** The drive ledger, why it does not read, or `null` when there is none. */
  ledger: Ledger | string | null;
  /** The drive as its own listing in a checkout here reads it. */
  row: DriveRow | null;
  /** This machine's launch records of the drive. */
  records: ReadRecord[];
}

/** The `drive` station's answer. */
export async function askDrive(ctx: AskContext): Promise<StationAnswer> {
  return (await readDrive(ctx)).answer;
}

/** The `drive` station's answer, and the records it read. */
export async function readDrive(ctx: AskContext): Promise<DriveReading> {
  const pull = await pullFor(ctx);
  if (pull.absent)
    return {
      answer: pull.answer,
      pull: null,
      comments: null,
      ledger: null,
      row: null,
      records: [],
    };
  const { doc } = pull;
  const pr = doc.number;
  const { raw, comments } = await commentsOf(ctx, pr);
  const local = await dispatcherReads(
    ctx,
    (r) => isDrive(r.record) && r.record.pr === pr,
    `PR #${pr}`,
  );
  const reads: DriveReads = {
    pull: doc,
    comments,
    snapshot: comments === null ? null : snapshotFrom(comments, ctx.login),
    claims:
      raw === null
        ? []
        : sharedClaimsFrom(
            "drive",
            raw,
            { repo: ctx.address.repo, pr },
            ctx.login,
          ),
    records: local.records,
    rows: local.rows.filter((r) => r.stage !== "followup"),
    row: await rowOf(ctx, pr),
  };
  const ledger = ledgerOf(reads.snapshot);
  const read = typeof ledger === "string" ? null : ledger;
  const { state, detail } = pull.read
    ? stateOf(ledger, doc, reads.row)
    : {
        state: "unknown",
        detail:
          "the pull request did not read, so whether it is open, merged or closed is not known",
      };
  const holder = holderOf(reads, read, ctx);
  const base = await baseHeadOf(ctx, read, doc);
  const presence = await silentPresence(read, doc, holder);
  const entries = recordEntries(reads, read, ctx);
  if (ctx.thread) entries.push(...(await threadReads(reads, ctx)));
  const answer: StationAnswer = {
    found: true,
    title: doc.title === "" ? null : doc.title,
    url: doc.url,
    holder,
    state:
      pull.read &&
      doc.state === "OPEN" &&
      locallyStopped(reads.row, read, holder)
        ? "stopped"
        : state,
    stateDetail: [detail, ...diagnosticDetail(reads.row, read, holder)].join(
      "; ",
    ),
    waitsOn: driveWait(reads, read, ctx, holder, {
      read: pull.read,
      base,
      presence,
      merge: await convergedWait(ctx, read, doc),
    }),
    last: lastOf(reads),
    entries,
  };
  return {
    answer,
    pull: { doc, read: pull.read },
    comments,
    ledger,
    row: reads.row,
    records: reads.records,
  };
}

/** The head of the pull request's base branch, which the classifier reads only for a ledger whose stop a conflict re-drives; noted in the sources. */
async function baseHeadOf(
  ctx: AskContext,
  ledger: Ledger | null,
  doc: PullDoc,
): Promise<PrFacts["base"]> {
  if (
    ledger === null ||
    doc.state !== "OPEN" ||
    !readsBaseHead(ledger, doc.mergeable)
  )
    return undefined;
  if (doc.baseRef === "")
    return { unreadable: "the forge reports no base branch for it" };
  const head = await readBranchHead(ctx.reading, ctx.address.repo, doc.baseRef);
  ctx.reading.note({
    record: "base-branch",
    read: head.ok,
    ...(head.ok ? {} : { detail: head.failure.reason }),
  });
  return head.ok ? { oid: head.value } : { unreadable: head.failure.reason };
}

/** The doctor's verdict on a drive, in words, with the recovery it gives. */
function doctorDetail(row: DriveRow | null): { detail?: string } {
  const doctor = row?.doctor;
  if (doctor == null) return {};
  const recovery =
    doctor.recovery === null ? "" : `; recovery: ${doctor.recovery}`;
  return { detail: `doctor: ${doctor.verdict}: ${doctor.reason}${recovery}` };
}

/** The drive as its own listing in a checkout of the repository on this machine reads it, noted in the sources. */
async function rowOf(ctx: AskContext, pr: number): Promise<DriveRow | null> {
  const { reading } = ctx;
  if (ctx.checkout === null) {
    reading.note({
      record: "drive-lock",
      read: false,
      local: true,
      detail: "no checkout of the repository on this machine",
    });
    return null;
  }
  const row = await driveRow(reading, ctx.checkout, pr);
  reading.note({
    record: "drive-lock",
    read: row.ok,
    local: true,
    ...(row.ok ? doctorDetail(row.value) : { detail: row.failure.reason }),
  });
  return row.ok ? row.value : null;
}

/** What this host shows of a silent ledger's driver that no launch holds, as the dispatcher reads it; `null` for any other ledger. */
async function silentPresence(
  ledger: Ledger | null,
  doc: PullDoc,
  holder: Holder | "none",
): Promise<DriverPresence | null> {
  if (
    ledger === null ||
    doc.state !== "OPEN" ||
    holder !== "none" ||
    ledger.driver.state !== "running" ||
    ledger.driver.personStop !== undefined
  )
    return null;
  const beat = Date.parse(ledger.driver.heartbeat);
  if (!Number.isFinite(beat) || Date.now() - beat <= stallThresholdMs())
    return null;
  return driverPresence(doc.number, ledger);
}

/** Select the station's wait after reconciling the current pull request and local diagnosis. */
function driveWait(
  reads: DriveReads,
  ledger: Ledger | null,
  ctx: AskContext,
  holder: Holder | "none",
  facts: {
    read: boolean;
    base: PrFacts["base"];
    presence: DriverPresence | null;
    merge: WaitsOn;
  },
): WaitsOn {
  if (!facts.read)
    return {
      waiting:
        "the pull request could not be read; its head and CI hold are unknown",
    };
  if (reads.pull.state !== "OPEN") return "none";
  if (facts.presence?.gone === true && ledger !== null) {
    const spent = takeoverSettled(
      reads.pull,
      reads.records,
      reads.claims,
      ctx.host,
      ledger,
      parkReading(ledger, reads.comments),
      facts.base,
    );
    return spent === null
      ? {
          waiting: `its heartbeat is past the lease window and this host shows its driver's run ended (${facts.presence.why}): a dispatcher may take it over, once per ledger state and within the pull request's recovery budget, and drive.ts --take-over decides`,
        }
      : personWait("re-arm", spent);
  }
  const diagnosis = diagnosticWait(reads.row, ledger, reads.pull, holder);
  if (diagnosis !== null) return diagnosis;
  return ledger === null
    ? "none"
    : waitsOnOf(ledger, reads, ctx, holder !== "none", facts.base, facts.merge);
}

/** The doctor names a stranded hold's guarded recovery; an unproven running ledger names a missing probe. */
function diagnosticWait(
  row: DriveRow | null,
  ledger: Ledger | null,
  doc: PullDoc,
  holder: Holder | "none",
): WaitsOn | null {
  if (ledger !== null && ledger.parked.length > 0) return null;
  const diagnosis = row?.doctor?.ciHold;
  if (diagnosis !== undefined && diagnosis.held !== false) {
    return holdWait(
      diagnosis,
      sameDriver(row, ledger),
      doc.head,
      holder === "none",
    );
  }
  if (
    ledger?.driver.state === "running" &&
    (holder === "none" || holder.process !== "alive")
  ) {
    return {
      waiting:
        diagnosis?.driver === "dead"
          ? `the local driver stopped while its ledger still reports running; ${diagnosis.driverReason}; inspect the drive doctor before re-arming`
          : "the ledger reports running, but driver liveness and ownership are unknown; inspect the owning driver's process or drive doctor",
    };
  }
  return null;
}

/** The shared diagnosis supplies the release proof; these reads must still describe the same run and head. */
function holdWait(
  diagnosis: CiHoldDiagnosis,
  matched: boolean,
  head: string,
  unheld: boolean,
): WaitsOn {
  const reason = `${diagnosis.driverReason}; ${diagnosis.reason}`;
  const current = diagnosis.head === head;
  if (
    matched &&
    current &&
    unheld &&
    diagnosis.recovery !== null &&
    diagnosis.driver === "dead" &&
    diagnosis.review === "converged"
  )
    return personWait(
      "release the CI hold",
      `${reason}; recovery: ${diagnosis.recovery}; this starts full CI, whose success remains to be checked`,
    );
  const missing = [reason];
  if (!matched)
    missing.push(
      "the local diagnosis does not identify the ledger writer, so ownership remains unknown",
    );
  if (!current)
    missing.push(
      "the diagnosis does not establish the current pull request head",
    );
  return { waiting: missing.join("; ") };
}

/** Only an identified stopped run with no active holder can override its ledger. */
function locallyStopped(
  row: DriveRow | null,
  ledger: Ledger | null,
  holder: Holder | "none",
): boolean {
  return (
    sameDriver(row, ledger) &&
    row?.doctor?.ciHold?.driver === "dead" &&
    holder === "none"
  );
}

/** A process probe applies only to the run that wrote the forge ledger. */
function sameDriver(row: DriveRow | null, ledger: Ledger | null): boolean {
  const diagnosis = row?.doctor?.ciHold;
  return (
    ledger !== null &&
    diagnosis !== undefined &&
    typeof diagnosis.actor === "string" &&
    diagnosis.actor === ledger.driver.actor &&
    typeof diagnosis.started === "string" &&
    diagnosis.started === ledger.driver.started &&
    diagnosis.ledgerGeneration === ledger.generation
  );
}

/** Separate what the ledger reports from what a local probe has established. */
function diagnosticDetail(
  row: DriveRow | null,
  ledger: Ledger | null,
  holder: Holder | "none",
): string[] {
  const detail: string[] = [];
  if (
    ledger?.driver.state === "running" &&
    (holder === "none" || holder.process !== "alive")
  )
    detail.push(
      "ledger reports running, but process liveness is not established by that ledger",
    );
  const diagnosis = row?.doctor?.ciHold;
  if (diagnosis !== undefined)
    detail.push(diagnosis.driverReason, diagnosis.reason);
  return detail;
}
