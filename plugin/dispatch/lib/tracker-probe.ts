/**
 * The tracker preflight's child (`run.ts tracker <slug> <deadline-ms>`):
 * open the repository's tracker from the configuration the tick read, which
 * it is handed on its input, in the repository's checkout, and ask whether
 * the tracker answers for it (`Tracker.reach`, which reads no issue). The
 * tick runs it in the environment a pass billed to one account runs in
 * (`passEnvironment`), so the credential it reads is the one that pass
 * would read. It prints `{"ok":true}`, or `{"ok":false,"kind":…,"reason":…}`
 * with the tracker's own answer and what that answer says of the
 * credential (`answerKind`).
 */
import { isMapping } from "../../shared/config-layers.ts";
import { isRateLimited } from "../../shared/tracker-budget.ts";
import { TrackerConfigError } from "../../skills/do-item/scripts/lib/tracker/config-error.ts";
import {
  openTracker,
  type Tracker,
} from "../../skills/do-item/scripts/lib/tracker/index.ts";
import { trackerConfigOf } from "./section.ts";
import type { TrackerAnswer } from "./preflight.ts";

/** The longest reason the probe prints. */
const REASON_CHARS = 300;

/**
 * An error as one bounded line: its whole message and every cause under it,
 * since a client's hint (`gh auth login`) is often on a later line or in a
 * cause. The adapters cap their own texts and never put a token in them.
 */
export function answerText(error: unknown): string {
  const parts: string[] = [];
  for (const at of chain(error)) {
    const text = (at instanceof Error ? at.message : String(at))
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "" && !parts.some((p) => p.includes(text))) parts.push(text);
  }
  const line = parts.join("; caused by: ") || "an unknown failure";
  return line.length > REASON_CHARS
    ? `${line.slice(0, REASON_CHARS - 1)}…`
    : line;
}

/** Each error in `error`'s cause chain, itself first. */
function chain(error: unknown): unknown[] {
  const out: unknown[] = [];
  for (
    let at: unknown = error;
    at !== undefined && at !== null && !out.includes(at);
    at = (at as { cause?: unknown }).cause
  ) {
    out.push(at);
    if (typeof at !== "object") break;
  }
  return out;
}

/** The answers of a tracker that is there but cannot take the request now: a server error, the network, a rate limit. */
const TRANSIENT =
  /\bAPI unreachable\b|\bHTTP (429|5\d\d)\b|could not resolve host|connection (refused|reset)|\b(RATE_?LIMITED|SERVICE_UNAVAILABLE)\b/i;

/**
 * What a failed `reach` says of the account's credential: `config` for a
 * tracker setting that cannot be used (`TrackerConfigError`), `transient`
 * for a rate limit (the shared budget refusing before a request leaves, or
 * the tracker's own refusal), a server error or the network, and
 * `unreachable` for everything else, the credential's own refusals and a
 * client that hangs on it included.
 */
export function answerKind(
  error: unknown,
): "unreachable" | "transient" | "config" {
  const errors = chain(error);
  if (errors.some((e) => e instanceof TrackerConfigError)) return "config";
  if (errors.some(isRateLimited)) return "transient";
  for (const e of errors) {
    const status = (e as { status?: unknown } | null)?.status;
    if (typeof status === "number" && (status === 429 || status >= 500))
      return "transient";
  }
  return errors.some((e) => TRANSIENT.test(answerText(e)))
    ? "transient"
    : "unreachable";
}

/**
 * The tracker's answer within `deadlineMs`, or why it gave none. A
 * configuration that does not open a tracker is `config`; a tracker that
 * gives no answer by the deadline is `unreachable`, as a credential waiting
 * on an approval nobody gives looks.
 */
export async function reachTracker(
  values: unknown,
  slug: string,
  root: string,
  deadlineMs: number,
): Promise<TrackerAnswer> {
  if (!isMapping(values))
    return {
      ok: false,
      kind: "config",
      reason: "the configuration handed to it is not a mapping",
    };
  let tracker: Tracker;
  try {
    tracker = openTracker(trackerConfigOf(values, slug), root);
  } catch (error) {
    return {
      ok: false,
      kind: "config",
      reason: `the tracker cannot be opened: ${answerText(error)}`,
    };
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(
          `the tracker gave no answer within ${deadlineMs / 1000} seconds`,
        ),
      ),
    deadlineMs,
  );
  try {
    await Promise.race([
      tracker.reach(deadline.signal),
      new Promise<never>((_, reject) =>
        deadline.signal.addEventListener("abort", () =>
          reject(deadline.signal.reason),
        ),
      ),
    ]);
    return { ok: true };
  } catch (error) {
    if (deadline.signal.aborted)
      return {
        ok: false,
        kind: "unreachable",
        reason: answerText(deadline.signal.reason),
      };
    return { ok: false, kind: answerKind(error), reason: answerText(error) };
  } finally {
    clearTimeout(timer);
  }
}
