/** The most output a durable digest keeps per pass. */
export const DURABLE_OUTPUT_LIMIT = 2000;

/**
 * The classified summary a durable digest may keep: credential-shaped
 * values, email addresses and long opaque strings are replaced, and only the
 * last `DURABLE_OUTPUT_LIMIT` characters remain. Redaction runs before the cut so
 * a secret split by it cannot survive.
 */
export function durableSummary(text: string): string {
  return text
    .replace(
      /(["'])([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_.-]*)\1\s*[:=]\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}\]]+)/gi,
      '$1$2$1: "[redacted]"',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_.-]*)\s*[=:]\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_.-]*)\s*[=:]\s*(?!\[)\S+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-|lin_api_)[A-Za-z0-9_-]{8,}/g,
      "[redacted]",
    )
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(
      /\b(?=[A-Za-z_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g,
      "[redacted]",
    )
    .slice(-DURABLE_OUTPUT_LIMIT);
}

/** Bounded pass output is diagnostic data; it never authorizes a recovery. */
export function passOutput(
  ran: { output?: string; said?: string },
  result: string | null,
  token: string,
): { said?: string; context?: string } {
  const redact = (text: string) =>
    token === "" ? text : text.split(token).join("[launch token]");
  const context = redact(ran.output ?? "").slice(-8000);
  const said = result === "done" ? "" : redact(ran.said?.trim() ?? "");
  return {
    ...(said === "" ? {} : { said }),
    ...(context.trim() === "" ? {} : { context }),
  };
}

/** Closed descriptions keep untrusted output out of the outcome log's reason. */
export function stewardNoSubmitCause(output: string): string {
  if (
    output.includes(
      "This skill can only be invoked by Claude, not directly by users",
    )
  )
    return "output reports a refused skill invocation";
  if (
    /^\s*you(?:'|’)ve hit your (?:session |weekly |usage )?limit\s*·\s*resets[^\r\n]+$/im.test(
      output,
    )
  )
    return "output reports a vendor usage limit";
  if (
    /bunfig\.toml/.test(output) &&
    /ENOENT|Cannot find config file|no such file/i.test(output)
  )
    return "output reports missing installed runtime configuration";
  return output.trim() === ""
    ? "unknown; no output was retained"
    : "unknown; inspect the retained output tail";
}
