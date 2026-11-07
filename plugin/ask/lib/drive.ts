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
 * On the machine that dispatched it, this machine's launch records name the
 * account, the session and whether the process runs; elsewhere the launch
 * claims on the forge say which host holds a launch and how the last one
 * ended. A drive nobody dispatched is read from its own listing in a
 * checkout of the repository, with the doctor's verdict and the recovery
 * command it gives, which is printed and never run.
 */
import {
  DRIVE_EXIT,
  driveExitName,
} from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { stallThresholdMs } from "../../skills/drive-pr/scripts/lib/doctor.ts";
import { answersKey } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
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
import { isDrive } from "../../dispatch/lib/launches.ts";
import { settleSharedConflictStops } from "../../dispatch/lib/shared-launches.ts";
import { driveClass, lastEnded } from "../../dispatch/lib/log.ts";
import {
  type Classified,
  classifyLedger,
  type ParkReading,
  type PrFacts,
} from "../../dispatch/lib/sources/ledgers.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import type { Holder, Last, ThreadEntry, WaitsOn } from "./answer.ts";
import {
  type CommentFields,
  commentFields,
  type PullDoc,
  readBranchHead,
  readComments,
} from "./forge.ts";
import { driveRow, type DriveRow } from "./local.ts";
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
  countsAsAnswer,
  localLaunchEntries,
  logEntries,
  loggedRecords,
} from "./thread.ts";
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
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

/** Whether a trusted comment made after the park answers its key, as the re-arm reads an answer. */
function answered(
  key: string,
  at: string | undefined,
  comments: readonly CommentFields[],
): boolean {
  if (at === undefined) return false;
  const after = Date.parse(at);
  return comments.some(
    (c) => countsAsAnswer(c, after) && answersKey(c.body, key),
  );
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

/** Why a stop on a conflict is a person's to settle, when this machine or another host already re-drove it for the change it shows now; `null` otherwise. */
function conflictSettled(
  placed: Classified,
  ledger: Ledger,
  r: DriveReads,
  host: string | null,
): string | null {
  if (placed.class !== "stale" || placed.stale?.conflictStop !== true)
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

/** What the drive waits on, from the class the dispatcher's classifier places its ledger in. */
function waitsOnOf(
  ledger: Ledger,
  r: DriveReads,
  ctx: AskContext,
  held: boolean,
  base: PrFacts["base"],
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
  if (settled !== null) return { person: "re-arm", why: settled };
  // A dispatcher re-arms what settles by itself: this machine's, or one whose launch claims are on the pull request.
  const dispatched = ctx.dispatches || current(r.claims) !== null;
  const rearm = (why: string): WaitsOn =>
    dispatched
      ? { waiting: why }
      : {
          person: "re-arm",
          why: `${why}; no dispatcher is known to re-arm it`,
        };
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
      return { person: "answer", why: placed.why };
    case "re-armable":
    case "stale":
      return rearm(placed.why);
    case "refused":
    case "unplaced":
      return { waiting: placed.why };
    case "done":
      return ledger.driver.exit === DRIVE_EXIT.CONVERGED
        ? {
            person: "merge",
            why: `${placed.why}; a person merges, and whether an approval or an update of the branch must come first is not read here`,
          }
        : "none";
    default:
      return { person: "re-arm", why: placed.why };
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
  const local = r.row?.lock === "live";
  if (!driven && !local) return "none";
  const doctor = r.row?.doctor;
  const why = local
    ? `a driver nobody dispatched holds its lock in this clone${doctor ? `; the doctor reads it ${doctor.verdict}` : ""}`
    : "the ledger names a running driver; its clone's lock is not on this machine";
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
  const entries = recordEntries(reads, read, ctx);
  if (ctx.thread) entries.push(...(await threadReads(reads, ctx)));
  const answer: StationAnswer = {
    found: true,
    title: doc.title === "" ? null : doc.title,
    url: doc.url,
    holder,
    state,
    stateDetail: detail,
    waitsOn:
      !pull.read || doc.state !== "OPEN" || read === null
        ? "none"
        : waitsOnOf(read, reads, ctx, holder !== "none", base),
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

/** The head of the pull request's base branch, which the classifier reads only for a ledger that stopped on a conflict; noted in the sources. */
async function baseHeadOf(
  ctx: AskContext,
  ledger: Ledger | null,
  doc: PullDoc,
): Promise<PrFacts["base"]> {
  if (
    ledger === null ||
    doc.state !== "OPEN" ||
    ledger.driver.state !== "stopped" ||
    ledger.driver.exit !== DRIVE_EXIT.PR_CONFLICTING
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
