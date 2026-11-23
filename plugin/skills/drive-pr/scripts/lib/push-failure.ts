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

/** The most bytes of the push's stderr kept to read the cause from. */
const TAIL_BYTES = 16 * 1024;

/** The most lines of the output the summary quotes. */
const QUOTED_LINES = 6;

/** The longest quoted line. */
const LINE_MAX = 200;

/** The longest quoted excerpt. */
const EXCERPT_MAX = 600;

/** Keeps the last `TAIL_BYTES` of a stream observed chunk by chunk. */
export function outputTail(): {
  observe: (bytes: Uint8Array) => void;
  text: () => string;
} {
  let kept = Buffer.alloc(0);
  return {
    observe(bytes) {
      // Mask before dropping the prefix.  A credential key can occur at the
      // start of one very long stderr line, with its value still in the tail
      // after the key would otherwise have been discarded.
      kept = Buffer.from(
        redactReportText(Buffer.concat([kept, bytes]).toString("utf8")),
      );
      if (kept.length > TAIL_BYTES)
        kept = kept.subarray(kept.length - TAIL_BYTES);
    },
    text: () => kept.toString("utf8"),
  };
}

/** The escape sequences terminals colour with: a gate's output is often coloured. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/**
 * The kind of a push failure, from the output that came with it. That output
 * holds the pre-push hook's own lines before git's, so each marker but the
 * last is one only `guarded-push.ts` or git writes, on a line of its own: a
 * gate whose output says `fatal:` or "connection refused" is still a gate.
 */
export function pushFailureKind(output: string): PushFailureKind {
  if (/^\d+s and was killed\.$/m.test(output)) return "timeout";
  if (output.split(/\r?\n|\r/).some(isUnconfirmedPush)) return "unconfirmed";
  if (/^\s*!\s*\[(remote )?rejected\]/m.test(output)) return "remote-rejected";
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
  const lines = output
    .replace(ANSI, "")
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
