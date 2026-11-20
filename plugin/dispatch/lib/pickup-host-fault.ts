/**
 * A pickup stopped by a fault of its host rather than of its work: the
 * root filesystem out of space or inodes, a state directory it cannot
 * write, a result the host could not record. The tick tells one from its
 * own records alone, by the first of:
 *
 * - its result or exit could not be written on this host
 *   (`unwritten-result.ts`);
 * - the question it stopped on is about the host's own fault: it reports
 *   space or inodes run out, or a file system or state directory that
 *   cannot be written (`HOST_FAULT_QUESTION`), as a failure, not as a topic;
 * - its closing report names the host's environment as the cause
 *   (`cause: environment`) and it asked nothing else: an environment
 *   cause covers a missing credential or a broken tree too, which only a
 *   person's answer clears, so a question beside it stays a person's.
 *
 * Such a stop asks nothing of a person. While the host's health check fails
 * the item is held with the fault named; once it passes, a claimed item is
 * relaunched once in its own tree to resume the pickup, and an item the
 * pass never claimed is picked up again (`plan-pickups.ts`,
 * `pickup-relaunch.ts`). A restart that stops on a host fault again is not
 * restarted a second time: it is one need, which a diagnosing session (the
 * steward) or a person takes. A batch's pickup is not restarted: its stop
 * stays a person's, as a batch's stall does.
 */
import type { ReadRecord } from "./launches.ts";
import { holdsItem } from "./launch-pickups.ts";
import { unwrittenResult } from "./session-startup.ts";
import { questionOf } from "./session.ts";

/**
 * A question about the host's own fault rather than the work's: the failure
 * as the host reports it (space or inodes run out, a write refused), never a
 * mere mention of inodes, `ENOSPC` or read-only file systems as a topic.
 */
const HOST_FAULT_QUESTION = new RegExp(
  [
    String.raw`\b(?:(?:ran |runs |running |run )?out of |exhausted (?:the |its )?|no (?:free )?|free (?:up )?(?:the |some )?)inodes\b`,
    String.raw`\binodes (?:are |were )?(?:exhausted|used up|all used)\b`,
    String.raw`\bno space left on (?:the )?device\b`,
    String.raw`\b(?:the |this |its )?(?:root |host's )?(?:disk|file ?system|volume) (?:is|was) (?:full|out of space|read-only)\b`,
    String.raw`\bout of disk space\b`,
    String.raw`\b(?:ENOSPC|EDQUOT|EROFS):`,
    String.raw`\b(?:state|dispatch) (?:directory|database) (?:is |was )?(?:not writable|unwritable|read-only)\b`,
  ].join("|"),
  "i",
);

const CLEANUP_VERB =
  /\b(?:i|we)\s+(?:(?:can|could|should|may|will|would|first|safely|now|also|then|just|simply)\s+){0,3}(?:remove|delete|free(?: up)?|clean(?: up)?|purge|prune|clear|wipe)\s+((?:[^,;:?!.]|\.(?!\s|$))*)/gi;
const HOST_RESOURCE = new Set(
  "cache caches file files fixture fixtures log logs tmp temp artifact artifacts output outputs space disk inodes inode directory directories image images checkout checkouts worktree worktrees".split(
    " ",
  ),
);
/** Extensions of files a host produces and a person clears; any other extension marks a work file. */
const HOST_ARTIFACT_EXTENSION =
  /\.(?:log|logs|tmp|temp|cache|bak|lock|pid|out|core|swp|old|trace|dump)$/i;
/** An archive or compression suffix: it carries no verdict of its own, the name beneath it decides. */
const ARCHIVE_EXTENSION = /\.(?:gz|bz2|xz|zst|tgz|tar|zip|7z|rar|iso)$/i;

/**
 * Whether a file name marks a work file. An archive is neutral: `app.log.gz`
 * is a host artifact over a host-artifact extension, `schema.sql.gz` a work
 * file over a work extension, and an archive with no extension beneath it
 * (`cache.tgz` against `source-files.tar.gz`) is a host artifact only when every
 * part of its own name is a host-resource word: a work word beside one keeps
 * the question a person's.
 */
function isWorkFileName(last: string): boolean {
  let stem = last;
  let archive = false;
  while (ARCHIVE_EXTENSION.test(stem)) {
    stem = stem.replace(ARCHIVE_EXTENSION, "");
    archive = true;
  }
  if (/\.\w+$/.test(stem)) return !HOST_ARTIFACT_EXTENSION.test(stem);
  if (!archive) return false;
  return !stem
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .every((part) => HOST_RESOURCE.has(part));
}

/** The first words of one cleanup object (the pattern already cut it at its clause or sentence end). */
function objectClause(rest: string): string[] {
  return rest.trim().split(/\s+/).slice(0, 4);
}

function namesHostResource(raw: string): boolean {
  const token = raw.replace(/^[`'"([]+|[`'")\].]+$/g, "");
  if (/^[~/][\w~./-]*$/.test(token)) {
    const last = (token.split("/").at(-1) ?? "").replace(/^\.+/, "");
    if (isWorkFileName(last)) return false;
    return token
      .toLowerCase()
      .split(/[/~]/)
      .some((seg) => HOST_RESOURCE.has(seg.replace(/^\./, "")));
  }
  const plain = token.replace(/^\./, "");
  if (!/^[\w'\u2019-]+$/.test(plain)) return false;
  return plain
    .toLowerCase()
    .replace(/['\u2019]s$/, "")
    .split("-")
    .some((part) => HOST_RESOURCE.has(part));
}

/**
 * Host recovery is cleanup the asker performs ("I"/"we" is the actor of the
 * verb) on a host resource; cleanup the code, tests or build would perform,
 * or of a work product such as a column, is implementation. Every cleanup
 * clause of the question is judged on its own: its object is the next few
 * words, cut at clause punctuation or a sentence end, and names a resource
 * as a plain or hyphenated word (a possessive or leading dot allowed) or as
 * a rooted path (`/` or `~`) whose last segment has no extension or a host-artifact one (a log, a temporary file), so a path to any other file is a work file however its directories are named. A
 * resource word inside a relative source path (`src/cache.ts`), past a comma
 * or in the next sentence is not the object.
 */
function cleansHostResource(text: string): boolean {
  for (const m of text.matchAll(CLEANUP_VERB)) {
    if (objectClause(m[1] ?? "").some(namesHostResource)) return true;
  }
  return false;
}

/**
 * A question that is explicitly about an observed host failure, not a test,
 * documentation or implementation question that quotes one. An implementation
 * question stays one unless it asks to repair a host resource (a remediation
 * verb acting on disk, inodes, space or fixtures); other verbs such as
 * restart never turn it into host recovery.
 */
function isHostFaultQuestion(question: string): boolean {
  const text = question.trim();
  if (
    /^(?:should|would|could|can|do|does|did)\b.{0,160}\b(?:assert|mock|include|document|documentation|explain|describe|mention|handle)\b/i.test(
      text,
    )
  )
    return false;
  const cleansItself = cleansHostResource(text);
  if (
    !cleansItself &&
    /^(?:should|would|could|can|do|does|did)\b(?=.{0,160}\b(?:test|tests|build|code|implementation|workflow)\b)(?=.{0,160}\b(?:retry|fail|failing)\b)/i.test(
      text,
    )
  )
    return false;
  return HOST_FAULT_QUESTION.test(text);
}

/** How the tick told a host fault. */
export type HostFaultKind = "unwritten" | "environment" | "question";

/** A pickup's stop on a fault of its host, and how it was told. */
export interface HostFault {
  kind: HostFaultKind;
  why: string;
}

/**
 * The question an ended pickup left for a person, or `null`: none after
 * `done` or a rate-limit wait, else the pass's trailing question, else the
 * question its closing report asks, or for a parked pass the question of its
 * framed decision. Question planning and
 * the release of unclaimed members read this one policy.
 */
export function endedQuestion(r: ReadRecord): string | null {
  if (r.result === "done" || r.result === "waits") return null;
  return (
    questionOf(r.state) ??
    r.report?.report.question ??
    (r.result === "parked" ? (r.framed?.decision.call.question ?? null) : null)
  );
}

/** Every recorded question, preserving the distinction between no question and a later question that changes its meaning. */
function endedQuestions(r: ReadRecord): string[] {
  return [
    questionOf(r.state),
    r.report?.report.question ?? null,
    r.framed?.decision.call.question ?? null,
  ].filter((question): question is string => question !== null);
}

/** A framed decision is a durable human checkpoint and may never be discharged by host-fault text. */
function hasHumanDecision(r: ReadRecord): boolean {
  return r.framed !== undefined || r.report?.report.decision !== undefined;
}

/** The host fault an ended pickup stopped on, or `null` when it ended on its work, handed its item on or is still running. */
export function hostFault(r: ReadRecord): HostFault | null {
  if (r.record.action !== "pickup") return null;
  if (r.state.kind !== "ended" && r.state.kind !== "died") return null;
  if (hasHumanDecision(r)) return null;
  if (unwrittenResult(r))
    return {
      kind: "unwritten",
      why: `its result or exit could not be written on this host (since ${r.unwritten})`,
    };
  if (r.result === "done" || r.result === "waits") return null;
  const questions = endedQuestions(r);
  const lastQuestion = questions.at(-1);
  if (lastQuestion !== undefined && questions.every(isHostFaultQuestion))
    return {
      kind: "question",
      why: `the question it stopped on is about the host's own fault: ${lastQuestion.replace(/\s+/g, " ").trim().slice(0, 300)}`,
    };
  if (questions.length === 0 && r.report?.report.cause === "environment")
    return {
      kind: "environment",
      why: "its closing report names the host's environment as the cause",
    };
  return null;
}

/**
 * Whether `latest` restarted a pickup that stopped on a host fault and
 * stopped on one again: a relaunch whose source did, or a fresh pickup
 * immediately after one of this item that did. A released intervening
 * pickup is a human-settled boundary, not something to skip over.
 */
export function faultedAgain(
  latest: ReadRecord,
  launches: readonly ReadRecord[],
  item: string,
): ReadRecord | null {
  if (hostFault(latest) === null) return null;
  const source =
    latest.record.relaunchOf === undefined
      ? previousPickup(latest, launches, item)
      : launches.find((r) => r.record.id === latest.record.relaunchOf);
  return source !== undefined &&
    holdsItem(source.record, item) &&
    hostFault(source) !== null
    ? source
    : null;
}

/** The item's immediately preceding pickup, if any. Its release is intentionally retained as a restart boundary. */
function previousPickup(
  latest: ReadRecord,
  launches: readonly ReadRecord[],
  item: string,
): ReadRecord | undefined {
  return launches
    .filter(
      (r) =>
        r.record.action === "pickup" &&
        r.record.id !== latest.record.id &&
        r.record.createdAt < latest.record.createdAt &&
        (r.record.item === item ||
          r.record.batchItems?.some((i) => i.key === item) === true),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
}
