/**
 * Two probes `drive-status.ts` runs before its round's report exists: a
 * bounded `realpath`, and the report of a read the forge's spent rate limit
 * refused.
 */
import { resolve } from "node:path";
import { runInlineProbe } from "../proc.ts";
import { definedFields } from "../../../../../shared/defined-fields.ts";
import { type ForgeLimit, limitLine, reportLimit } from "../forge-limit.ts";
import { forgeRateLimited } from "./terminal-states.ts";

/**
 * `realpathSync`, bounded — a stalled FUSE/NFS mount can block this SYNCHRONOUS
 * call indefinitely in THIS process, which `GIT_CALL_TIMEOUT` does nothing
 * for. So it runs as a bounded inline probe (`runInlineProbe`, from a neutral
 * directory: the path is made absolute against this process's cwd first).
 */
const REALPATH_PROBE_SCRIPT = `
const { realpathSync } = require('node:fs');
const [p] = process.argv.slice(1);
try {
  process.stdout.write(realpathSync(p));
} catch {}
process.exit(0);
`;

export async function boundedRealpath(
  p: string,
  timeoutSec: number,
): Promise<string | null> {
  // `realpathSync('')` resolves to `process.cwd()` instead of throwing (a
  // Node/Bun quirk, verified empirically) — every caller here treats an empty
  // string as "nothing to resolve", never as "resolve my cwd", so this must
  // refuse before ever reaching the probe subprocess.
  if (p === "") return null;
  const probe = await runInlineProbe(REALPATH_PROBE_SCRIPT, [resolve(p)], {
    stderr: "ignore",
    ...definedFields({ timeoutSec }),
  });
  if (probe.code !== 0) return null;
  const resolved = probe.stdout.trim();
  return resolved === "" ? null : resolved;
}

/**
 * A read met the forge's spent rate limit before the round's report exists
 * (the repository's own read): the report's state, exit and reset alone, so
 * the caller reads the limit, not a missing prerequisite.
 */
export function limitedAtStart(
  pr: string,
  json: boolean,
  limit: ForgeLimit,
): number {
  const report = { state: "", reason: "" };
  const code = forgeRateLimited(
    report,
    `cannot read PR #${pr}'s repository: ${limitLine(limit)}; nothing more is sent before the reset`,
  );
  if (json)
    process.stdout.write(
      `${JSON.stringify({
        state: report.state,
        exit: code,
        pr: Number.parseInt(pr, 10),
        reason: report.reason,
        rateLimit: reportLimit(limit),
      })}\n`,
    );
  else {
    process.stdout.write(`${report.state}\n`);
    console.error(`drive-status.ts: ${report.reason}`);
  }
  return code;
}
