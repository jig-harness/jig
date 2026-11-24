/**
 * Why a `guarded-push.ts` push failed, read from what it wrote on stderr,
 * for the `PUSH_FAILED` finish `finish-round.ts` records
 * (`state/round-finish.ts`). The stall stop, the drive's `stop` event, its
 * ledger and its closing report carry that finish, so whoever reads the
 * stop learns what refused the push without the pass's log.
 *
 * The kind is read from the output's own markers, each a line of its own,
 * first match wins:
 *
 * | Kind | Marker |
 * | --- | --- |
 * | `timeout` | `guarded-push.ts` killed the push at `$DRIVE_PR_PUSH_TIMEOUT` |
 * | `unconfirmed` | `guarded-push.ts` pushed, and the pull request never reported the pushed head |
 * | `remote-rejected` | git's `! [rejected]` or `! [remote rejected]` line |
 * | `transport` | git's `fatal:` line for a remote it could not reach or that hung up, ssh's refused connection, or a failed RPC |
 * | `pre-push-gate` | git's `failed to push some refs` with none of the above: the local pre-push hook refused |
 * | `unknown` | anything else, a child that never started included, whose error is quoted |
 */
import { redactReportText } from "../../../../shared/closing-report.ts";
import { run } from "./proc.ts";

export type PushFailureKind =
  | "timeout"
  | "unconfirmed"
  | "remote-rejected"
  | "transport"
  | "pre-push-gate"
  | "unknown";

/** What each kind says, in words a person reads. */
export const PUSH_FAILURE_WORDS: Readonly<Record<PushFailureKind, string>> = {
  timeout: "the push, pre-push gates included, ran past $DRIVE_PR_PUSH_TIMEOUT",
  unconfirmed:
    "the push ran, but the pull request never reported the pushed head",
  "remote-rejected": "the remote rejected the push",
  transport: "the push could not reach the remote",
  "pre-push-gate": "the pre-push hook's gates refused the push",
  unknown: "the push failed",
};

/** Whether one guarded-push diagnostic says the forge never confirmed its head. */
function isUnconfirmedPush(line: string): boolean {
  const prefix = "guarded-push: pushed ";
  if (!line.startsWith(prefix)) return false;
  const pushedEnd = line.indexOf(" to ", prefix.length);
  if (pushedEnd === prefix.length) return false;
  const remoteEnd = line.indexOf(", but PR #", pushedEnd + 4);
  if (remoteEnd === pushedEnd + 4) return false;
  const reports = " still reports ";
  const number = line.slice(remoteEnd + ", but PR #".length);
  const reportsAt = number.indexOf(reports);
  return (
    reportsAt > 0 &&
    /^[1-9][0-9]*$/.test(number.slice(0, reportsAt)) &&
    number.slice(reportsAt + reports.length) !== ""
  );
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** The longest cut escape sequence held across chunks; a longer one is discarded through its terminator. */
const ESCAPE_MAX = 256;

/**
 * The escape sequences a terminal reads (ECMA-48): a control sequence (any
 * parameter bytes, then intermediates, then a final byte, so the colon form
 * of a colour is one), an operating-system command up to its terminator, and
 * a two-byte escape. A gate's output is often coloured.
 */
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  "g",
);

/** An escape sequence the end of a chunk cut short. */
const CUT_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*|\\][^${ESC}${BEL}]*${ESC}?)?$`,
);

/** Strip the terminal escapes from `text`. */
const stripEscapes = (text: string): string => text.replace(ANSI, "");

/** What stands where output too long to read whole was dropped. */
const OMITTED = "[over-long output omitted]\n";

/** The most bytes of the push's stderr kept to read the cause from. */
const TAIL_BYTES = 16 * 1024;

/** The most lines of the output the summary quotes. */
const QUOTED_LINES = 6;

/** The longest quoted line. */
const LINE_MAX = 200;

/** The longest quoted excerpt. */
const EXCERPT_MAX = 600;

/** The most raw bytes held before the whole of them is dropped, so a stream that never ends cannot grow without bound. */
const RAW_MAX = 256 * 1024;

/** Where a quote scan stands: the quote byte of an open value (0 for none) and whether a backslash is pending. */
interface QuoteState {
  q: number;
  esc: boolean;
  /** A quote ended the last chunk inside a value: whether it closes or doubles waits on the next byte. */
  pend?: boolean;
}

const isSpace = (b: number | undefined): boolean =>
  b === 32 || b === 9 || b === 10 || b === 13;

/** Whether the quote at `buf[i]` stands in value position: after `=` or `:`, or with nothing before it. */
function opensValue(buf: Buffer, i: number): boolean {
  if (buf[i] !== 34 && buf[i] !== 39) return false;
  let j = i - 1;
  while (j >= 0 && isSpace(buf[j])) j--;
  return j < 0 || buf[j] === 61 || buf[j] === 58;
}

/**
 * The quote state at the end of `buf`, started from `start`, and where the
 * still-open quote began (`-1` when none opened inside `buf`). Only a quote
 * in value position (after `=` or `:`, or with nothing before it) opens a
 * value, as the masker reads one; inside it a backslash escapes the next
 * byte and a doubled quote stays inside. With `stopAtClose` the scan ends at
 * the byte after the quote that closes a value open on entry.
 */
function scanQuotes(
  buf: Buffer,
  start: QuoteState,
  stopAtClose = false,
): { state: QuoteState; openAt: number; end: number } {
  const s = { q: start.q, esc: start.esc, pend: false, openAt: -1 };
  if (buf.length === 0) return { state: start, openAt: -1, end: -1 };
  const i0 = resumeAfterQuote(buf, start, s);
  if (i0 < 0 && stopAtClose)
    return { state: { q: 0, esc: false }, openAt: -1, end: 0 };
  for (let i = Math.max(i0, 0); i < buf.length; i++) {
    if (s.q !== 0) {
      const skip = stepInQuote(buf, i, s, stopAtClose);
      if (skip < 0 && stopAtClose)
        return { state: { q: 0, esc: s.esc }, openAt: -1, end: i + 1 };
      if (skip > 0) i += skip;
    } else if (opensValue(buf, i)) {
      s.q = buf[i] as number;
      s.openAt = i;
    }
  }
  const state = s.pend
    ? { q: s.q, esc: s.esc, pend: true }
    : { q: s.q, esc: s.esc };
  return { state, openAt: s.openAt, end: -1 };
}

/**
 * Where the scan starts when the previous chunk ended on a quote: after a
 * second quote that doubles it, else at the start with the value closed
 * (`-1`, the value ended before this chunk).
 */
function resumeAfterQuote(
  buf: Buffer,
  start: QuoteState,
  s: { q: number },
): number {
  if (!start.pend || s.q === 0) return 0;
  if (buf[0] === s.q) return 1;
  s.q = 0;
  return -1;
}

/** One byte inside a quoted value: the bytes to skip after it, or -1 when it closed the value. */
function stepInQuote(
  buf: Buffer,
  i: number,
  s: { q: number; esc: boolean; pend: boolean; openAt: number },
  stopAtClose: boolean,
): number {
  const b = buf[i] as number;
  if (s.esc) {
    s.esc = false;
    return 0;
  }
  if (b === 92) {
    s.esc = true;
    return 0;
  }
  if (b !== s.q) return 0;
  if (i + 1 === buf.length && stopAtClose) {
    s.pend = true;
    return 0;
  }
  if (buf[i + 1] === s.q) return 1;
  s.q = 0;
  s.openAt = -1;
  return -1;
}

/** Where an oversized escape sequence ends in `text`: the index after its terminator (or at the byte that cut it short), -1 while it goes on. */
function discardEnd(text: string, csi: boolean): number {
  for (let i = 0; i < text.length; i++) {
    const b = text.charCodeAt(i);
    if (csi) {
      if (b >= 0x20 && b <= 0x3f) continue;
      return b >= 0x40 && b <= 0x7e ? i + 1 : i;
    }
    if (b === 7) return i + 1;
    if (b === 27) return i;
  }
  return -1;
}

/**
 * Keeps the end of a stream observed chunk by chunk. The raw bytes are held
 * whole and masked and decoded once, when the text is read: a credential, a
 * multi-byte character or a quoted value that spans lines is never read in
 * pieces, and terminal escapes are stripped before masking, so one inside a
 * credential's key cannot hide it.
 *
 * A value is never published without its key. Past `RAW_MAX` the older half
 * is dropped up to a line boundary; the quote state the dropped part ends in
 * is tracked (escapes included), and a value it left open is dropped from
 * the kept bytes through its closing quote and the rest of that line, as is
 * the rest of a line the drop ended inside. When the text is read, a value
 * still open at the end is dropped from its key's line on.
 */
export function outputTail(): {
  observe: (bytes: Uint8Array) => void;
  text: () => string;
} {
  let raw: Buffer = Buffer.alloc(0);
  let omitted = false;
  // The quote state a dropped part left, still to be closed in what follows.
  let head: QuoteState = { q: 0, esc: false };
  // Whether the rest of the current line is still to be dropped.
  let skipping = false;
  // An escape sequence cut by the end of the last chunk, still to be completed.
  let carry = "";
  // An escape sequence too long to hold, still being discarded: its kind.
  let discarding: "csi" | "osc" | null = null;

  /** Drop the rest of an oversized escape sequence from the front of `text`. */
  const discard = (text: string): string => {
    const end = discardEnd(text, discarding === "csi");
    if (end < 0) return "";
    discarding = null;
    return text.slice(end);
  };

  /** Strip terminal escapes from a chunk, as the masker reads the text, holding back a cut one. */
  const normalize = (input: Uint8Array): Buffer => {
    let text = Buffer.from(input).toString("latin1");
    if (discarding) text = discard(text);
    text = carry + text;
    const cut = CUT_ESCAPE.exec(text);
    // A cut sequence is held only up to a bound; a longer one is dropped and
    // the rest of it discarded as it arrives, so the held text stays bounded
    // and nothing of it is published or read as text.
    carry = cut && cut[0].length <= ESCAPE_MAX ? cut[0] : "";
    if (cut && cut[0].length > ESCAPE_MAX)
      discarding = cut[0][1] === "]" ? "osc" : "csi";
    const whole = cut ? text.slice(0, cut.index) : text;
    return Buffer.from(stripEscapes(whole), "latin1");
  };

  /** Drop what a drop left unsafe from the front of `buf`. */
  const settle = (buf: Buffer): Buffer => {
    let rest = buf;
    if (head.q !== 0) {
      const r = scanQuotes(rest, head, true);
      head = r.state;
      if (r.end < 0) return Buffer.alloc(0);
      skipping = true;
      rest = rest.subarray(r.end);
    }
    if (skipping) {
      const nl = rest.indexOf(10);
      if (nl < 0) return Buffer.alloc(0);
      skipping = false;
      rest = rest.subarray(nl + 1);
    }
    return rest;
  };

  return {
    observe(input) {
      raw = Buffer.concat([raw, settle(normalize(input))]);
      if (raw.length <= RAW_MAX) return;
      omitted = true;
      const nl = raw.indexOf(10, raw.length - RAW_MAX / 2);
      const cut = nl < 0 ? raw.length : nl + 1;
      const dropped = raw.subarray(0, cut);
      head = scanQuotes(dropped, { q: 0, esc: false }).state;
      skipping = dropped[dropped.length - 1] !== 10;
      raw = settle(Buffer.from(raw.subarray(cut)));
    },
    text: () => {
      let bytes = raw;
      const { state, openAt } = scanQuotes(raw, { q: 0, esc: false });
      if (state.q !== 0 && openAt >= 0) {
        let key = openAt - 1;
        while (key >= 0 && isSpace(raw[key])) key--;
        bytes = raw.subarray(0, key < 0 ? 0 : raw.lastIndexOf(10, key) + 1);
      }
      const masked = redactReportText(stripEscapes(bytes.toString("utf8")));
      const kept =
        masked.length > TAIL_BYTES
          ? masked.slice(masked.length - TAIL_BYTES)
          : masked;
      return omitted ? OMITTED + kept : kept;
    },
  };
}

/**
 * The kind of a push failure, from the output that came with it. That output
 * holds the pre-push hook's own lines before git's, so each marker but the
 * last is one only `guarded-push.ts` or git writes, on a line of its own: a
 * gate whose output says `fatal:` or "connection refused" is still a gate.
 */
export function pushFailureKind(output: string): PushFailureKind {
  if (/^\d+s and was killed\.$/m.test(output)) return "timeout";
  if (output.split(/\r?\n|\r/).some(isUnconfirmedPush)) return "unconfirmed";
  if (/^[ \t]*![ \t]*\[(remote )?rejected\]/m.test(output))
    return "remote-rejected";
  if (
    /^(fatal: (unable to access|the remote end hung up|could not read from remote repository)|ssh: connect to host|error: RPC failed)/im.test(
      output,
    )
  )
    return "transport";
  if (/^error: failed to push some refs/m.test(output)) return "pre-push-gate";
  return "unknown";
}

/**
 * The last few lines of `output` that say something, each cut to a line's
 * bound and the whole to the excerpt's, redacted as a report is: the
 * excerpt reaches the ledger, a pull request comment.
 */
export function failureExcerpt(output: string): string {
  const lines = stripEscapes(output)
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^guarded-push: push to PR/.test(line))
    .slice(-QUOTED_LINES)
    .map((line) =>
      line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line,
    );
  const joined = redactReportText(lines.join(" | "));
  return joined.length > EXCERPT_MAX
    ? `…${joined.slice(joined.length - EXCERPT_MAX + 1)}`
    : joined;
}

/** The `PUSH_FAILED` reason for a push that exited `code` with `output` on stderr. */
export function pushFailureReason(code: number, output: string): string {
  const kind = pushFailureKind(output);
  const excerpt = failureExcerpt(output);
  return `guarded-push.ts exited ${code} (${kind}): ${PUSH_FAILURE_WORDS[kind]}${excerpt === "" ? "; it wrote nothing on stderr" : ` — ${excerpt}`}`;
}

/**
 * Run `argv` (`guarded-push.ts`) with its stderr passed through as it is
 * written and its stdout captured, keeping the stderr's tail: `failure` is
 * the `PUSH_FAILED` reason for the exit it returned.
 */
export async function observedPush(argv: string[]): Promise<{
  res: Awaited<ReturnType<typeof run>>;
  failure: () => string;
}> {
  const tail = outputTail();
  const res = await run(argv, {
    stdout: "pipe",
    stderr: "inherit",
    onInheritedOutput: (stream, bytes) => {
      if (stream === "stderr") tail.observe(bytes);
    },
  });
  // A child that never started wrote nothing to observe: its spawn error is
  // in the result instead.
  return {
    res,
    failure: () => pushFailureReason(res.code, tail.text() || res.stderr),
  };
}
