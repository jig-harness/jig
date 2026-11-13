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
