/**
 * Why a `guarded-push.ts` push failed, read from what it wrote on stderr,
 * for the `PUSH_FAILED` finish `finish-round.ts` records
 * (`state/round-finish.ts`). The stall stop, the drive's `stop` event, its
 * ledger and its closing report carry that finish, so whoever reads the
 * stop learns what refused the push without the pass's log.
 *
 * The kind is read from the output's own markers, first match wins:
 *
 * | Kind | Marker |
 * | --- | --- |
 * | `timeout` | `guarded-push.ts` killed the push at `$DRIVE_PR_PUSH_TIMEOUT` |
 * | `unconfirmed` | the push ran, and the pull request never reported the pushed head |
 * | `remote-rejected` | git's `! [rejected]` or `! [remote rejected]` line, or a remote hook that declined |
 * | `transport` | git's `fatal:` line, or a connection that failed |
 * | `pre-push-gate` | git's `failed to push some refs` with none of the above: the local pre-push hook refused |
 * | `unknown` | anything else |
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
      kept = Buffer.concat([kept, bytes]);
      if (kept.length > TAIL_BYTES)
        kept = kept.subarray(kept.length - TAIL_BYTES);
    },
    text: () => kept.toString("utf8"),
  };
}

/** The escape sequences terminals colour with: a gate's output is often coloured. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** The kind of a push failure, from the output that came with it. */
export function pushFailureKind(output: string): PushFailureKind {
  if (/and was killed/.test(output)) return "timeout";
  if (/still reports \S+\.?\s*$/m.test(output)) return "unconfirmed";
  if (
    /!\s*\[(remote )?rejected\]/.test(output) ||
    /pre-receive hook declined/i.test(output)
  )
    return "remote-rejected";
  if (
    /^fatal:/m.test(output) ||
    /could not resolve host|connection (timed out|refused|reset)|unable to access|remote end hung up/i.test(
      output,
    )
  )
    return "transport";
  if (/failed to push some refs/.test(output)) return "pre-push-gate";
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
  return { res, failure: () => pushFailureReason(res.code, tail.text()) };
}
