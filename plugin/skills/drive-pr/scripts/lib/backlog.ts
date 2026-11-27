/**
 * The reviewer's backlog and body bullets as the sticky carries them: the
 * backlog blob decoded, the summary bullets parsed, and the backlog split by
 * the disposition the reviewer gave each entry.
 */
import { ADDRESSED_MARKER } from "../../../../shared/summary-answer-blocks.ts";
import { fingerprintOf } from "./finding-fingerprint.ts";
import { withoutFencedExamples } from "./markdown-examples.ts";
import { MARKER_SAFE_FINGERPRINT } from "./summary-answer.ts";

export interface BacklogEntry {
  fingerprint: string;
  path: string;
  line: number | null;
  severity: string;
  dimension: string;
  /** A `categories` token from `.config/review-triage.yaml`, or `unknown` — see `categoryOf`. */
  category: string;
  confidence?: string;
  scope?: string;
  comment: string;
  firstRound?: number;
  reason?: string;
  blocking?: boolean;
}

/**
 * A PRESENT marker must decode to a well-formed array of well-formed entries or
 * this throws. There is no partial-credit path: an absent marker is a real zero,
 * but a marker we cannot fully understand means the reviewer's format moved
 * under us, and the only safe reading of "I no longer understand the held
 * findings" is INDETERMINATE. Returning `[]` for a non-array payload, or
 * silently dropping entries that merely lack a `fingerprint`, would turn a
 * reviewer-side format change into a clean convergence with live findings held
 * behind it.
 */
export function decodeBacklog(body: string): BacklogEntry[] {
  const m = body.match(/<!--\s*ai-review-backlog:\s*([A-Za-z0-9+/=]+)\s*-->/);
  if (!m) return [];
  const fail = (why: string): never => {
    throw new Error(`ai-review-backlog present but ${why}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(m[1] ?? "", "base64").toString("utf8"));
  } catch {
    return fail("not decodable");
  }
  if (!Array.isArray(parsed)) return fail("not a JSON array");
  // A fingerprint is the backlog's identity for a finding, and downstream it is
  // the key everything else is decided on: `push()` drops a repeat, and one
  // answer marker clears whatever the key names. Two entries sharing one — a
  // reviewer-side collision or a truncating hash on its side — therefore silently
  // becomes one finding, and answering it retires a second one nobody ever read.
  // Malformed, like every other shape violation here, rather than deduplicated:
  // the entries are distinct by construction, so a repeat means the identity we
  // are keying on is not an identity.
  const seen = new Set<string>();
  return parsed.map((e, i): BacklogEntry => {
    const entry = checkedEntry(e, i, fail);
    if (seen.has(entry.fingerprint as string)) {
      return fail(
        `entry ${i} repeats fingerprint \`${entry.fingerprint}\` — two findings under one key would silently become one`,
      );
    }
    seen.add(entry.fingerprint as string);
    return backlogEntryOf(entry);
  });
}

/** Entry `i` of the blob, once its required fields hold; `fail` otherwise. */
function checkedEntry(
  e: unknown,
  i: number,
  fail: (why: string) => never,
): Record<string, unknown> {
  if (typeof e !== "object" || e === null) {
    return fail(`entry ${i} is not an object`);
  }
  const entry = e as Record<string, unknown>;
  for (const key of ["fingerprint", "path", "comment"] as const) {
    if (typeof entry[key] !== "string" || entry[key] === "") {
      return fail(`entry ${i} has no usable \`${key}\``);
    }
  }
  if (entry.line != null && typeof entry.line !== "number") {
    return fail(`entry ${i} has a non-numeric \`line\``);
  }
  if (!MARKER_SAFE_FINGERPRINT.test(entry.fingerprint as string)) {
    return fail(
      `entry ${i} has a fingerprint \`${entry.fingerprint}\` that cannot round-trip through a ${ADDRESSED_MARKER} marker — it could never be answered`,
    );
  }
  return entry;
}

const textOr = (v: unknown): string => (typeof v === "string" ? v : "unknown");

/** A checked entry as a `BacklogEntry`. */
function backlogEntryOf(entry: Record<string, unknown>): BacklogEntry {
  return {
    fingerprint: entry.fingerprint as string,
    path: entry.path as string,
    line: (entry.line as number | null) ?? null,
    severity: textOr(entry.severity),
    dimension: textOr(entry.dimension),
    // Same wrong-type-degrades-to-absent contract as `severity`/`dimension`
    // above: a malformed `category` costs the one field, never the blob.
    category: textOr(entry.category),
    comment: entry.comment as string,
    // Keep the reviewer's provenance and disposition. The reason and
    // blocking flag count only when their types match the reviewer format.
    ...(typeof entry.firstRound === "number"
      ? { firstRound: entry.firstRound }
      : {}),
    ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
    ...(typeof entry.blocking === "boolean"
      ? { blocking: entry.blocking }
      : {}),
  };
}

export interface BodyFinding {
  path: string;
  line: number | null;
  text: string;
}

/**
 * Finding bullets from the summary body, EXCLUDING the `<details>` block — that
 * block renders the backlog, which is already parsed from its own blob and
 * would otherwise be counted twice.
 */
export function parseBodyFindings(body: string): BodyFinding[] {
  // A reviewer can use other collapsed sections before or after its backlog.
  // Exclude only the named backlog itself; summary bullets elsewhere still
  // describe fresh work.
  const head = withoutFencedExamples(body)
    // Examples in a diagnostic or another collapsed section are prose, not
    // findings.  Only actual Markdown bullets participate in the summary.
    .replace(
      /<details><summary>🗂️ <b>Beyond this PR<\/b>[\s\S]*?<\/details>/g,
      "",
    );
  const out: BodyFinding[] = [];
  for (const line of head.split("\n")) {
    const m = line.match(/^[-*]\s+`([^`]+)`\s+[—–-]\s+(.*)$/);
    if (!m) continue;
    const loc = m[1] ?? "";
    const lineMatch = loc.match(/^(.*):(\d+)$/);
    out.push({
      path: lineMatch ? (lineMatch[1] ?? "") : loc,
      line: lineMatch ? Number.parseInt(lineMatch[2] ?? "", 10) : null,
      text: (m[2] ?? "").trim(),
    });
  }
  return out;
}

/**
 * The backlog split by the reviewer's disposition: the entries that block
 * convergence, the informational ones it skips, and the blocking ones it
 * renders as not blocking (`renderedNotBlocking`).
 */
export function partitionBacklog(
  stickyBody: string,
  bullets: readonly BodyFinding[],
): {
  blockingBacklog: BacklogEntry[];
  ignoredBacklog: BacklogEntry[];
  notBlockingBacklog: string[];
} {
  const backlog = decodeBacklog(stickyBody);
  // The declared disposition applies only to the entries rendered in this
  // section. A count alone cannot establish that: a different blocking entry
  // can leave the count unchanged. Match the rendered finding identities to
  // the blob before treating its otherwise-unflagged entries as informational.
  const section = withoutFencedExamples(stickyBody).match(
    /<details><summary>🗂️ <b>Beyond this PR<\/b> — (\d+) finding\(s\) for triage \(not posted inline\)<\/summary>\r?\n[ \t\r\n]*Held out of the inline threads so this PR can converge — \*\*not blocking\*\*\.([\s\S]*?)<\/details>/,
  );
  const rendered = section ? parseBodyFindings(section[2] ?? "") : [];
  // A fingerprint is authoritative whenever the renderer preserves the full
  // text. An abbreviated renderer cannot establish the identity of a backlog
  // entry, even when its location and prefix match exactly one current entry:
  // another entry can later share those rendered fields. It therefore remains
  // blocking until the renderer supplies the complete fingerprint.
  const renderedFingerprints = new Map<string, number>();
  for (const finding of rendered) {
    const fingerprint = fingerprintOf(finding.path, finding.line, finding.text);
    renderedFingerprints.set(
      fingerprint,
      (renderedFingerprints.get(fingerprint) ?? 0) + 1,
    );
  }
  const backlogFingerprints = new Map<string, number>();
  for (const entry of backlog) {
    backlogFingerprints.set(
      entry.fingerprint,
      (backlogFingerprints.get(entry.fingerprint) ?? 0) + 1,
    );
  }
  const freshFingerprints = new Set(
    bullets.map((f) => fingerprintOf(f.path, f.line, f.text)),
  );
  const blockingBacklog: BacklogEntry[] = [];
  const ignoredBacklog: BacklogEntry[] = [];
  for (const entry of backlog) {
    const informational =
      entry.blocking !== true &&
      (entry.blocking === false ||
        entry.reason === "winddown-deferred" ||
        (section !== null &&
          renderedFingerprints.get(entry.fingerprint) === 1 &&
          backlogFingerprints.get(entry.fingerprint) === 1));
    if (!informational) blockingBacklog.push(entry);
    // A fresh body bullet takes precedence over a carry-forward disposition.
    else if (!freshFingerprints.has(entry.fingerprint))
      ignoredBacklog.push(entry);
  }
  return {
    blockingBacklog,
    ignoredBacklog,
    notBlockingBacklog: renderedNotBlocking(
      blockingBacklog,
      backlog,
      rendered,
      freshFingerprints,
      bullets,
    ),
  };
}

/** A rendered bullet's severity and category header: an icon, the bold severity, optional fields, then ` — `. */
const BULLET_HEADER = /^\S+ \*\*[A-Za-z]+\*\*[^—]* — $/;

/** Whether a bullet is at the entry's location and reads its recorded comment, whole or after a header. */
function reads(b: BodyFinding, e: BacklogEntry): boolean {
  if (b.path !== e.path || b.line !== e.line) return false;
  if (b.text === e.comment) return true;
  return (
    b.text.endsWith(e.comment) &&
    BULLET_HEADER.test(b.text.slice(0, b.text.length - e.comment.length))
  );
}

/**
 * The blocking backlog entries the reviewer renders in its "Beyond this PR"
 * section, which it labels not blocking, by fingerprint.
 *
 * Convergence keeps such an entry blocking when its rendering abbreviates the
 * comment, since no rendered field then reproduces the fingerprint that
 * answers it (`partitionBacklog`). Whether the entry blocks is a different
 * question, and the reviewer's own record answers it: the blob carries the
 * same abbreviated comment the section renders. So an entry counts as
 * rendered not blocking when it is not flagged `blocking: true`, no fresh body
 * bullet raises it again, and exactly one bullet of the section sits at its
 * path and line and reads its recorded comment (the whole text, or the text
 * after the bullet's severity and category header), that bullet matching no
 * other entry. An entry the section does not render, or renders ambiguously,
 * stays counted.
 */
export function renderedNotBlocking(
  candidates: readonly BacklogEntry[],
  backlog: readonly BacklogEntry[],
  rendered: readonly BodyFinding[],
  fresh: ReadonlySet<string>,
  freshBullets: readonly BodyFinding[] = [],
): string[] {
  const out: string[] = [];
  for (const entry of candidates) {
    if (entry.blocking === true || fresh.has(entry.fingerprint)) continue;
    // A fresh bullet at the entry's location that reads its comment raises it
    // again, whatever header or abbreviation changes its fingerprint.
    if (freshBullets.some((b) => reads(b, entry))) continue;
    const bullets = rendered.filter((b) => reads(b, entry));
    if (bullets.length !== 1) continue;
    const bullet = bullets[0] as BodyFinding;
    if (backlog.filter((e) => reads(bullet, e)).length !== 1) continue;
    out.push(entry.fingerprint);
  }
  return out;
}
