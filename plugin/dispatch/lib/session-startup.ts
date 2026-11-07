/** A headless session that stopped before it could start, not a pass that died during work. */
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  forEachDirEntry,
  readBoundedTail,
} from "../../skills/drive-pr/scripts/lib/quota/types.ts";
import type { LaunchRecord, ReadRecord } from "./launches.ts";
import { swallow } from "../../shared/errors.ts";

/** Startup failures are limited to the first minute of the vendor process. */
const STARTUP_MS = 60_000;

/**
 * A complete bounded scan must confirm absence. A matching filename proves
 * presence conservatively; content also catches transcripts named differently.
 * Any unreadable file or truncated scan withholds the retry.
 */
function transcriptFiles(configDir: string, deadline: number): string[] | null {
  const files: string[] = [];
  let entries = 0;
  let complete = true;
  const budget = () => {
    if (++entries > 10_000 || Date.now() >= deadline) complete = false;
    return complete;
  };
  const root = join(configDir, "projects");
  const read = forEachDirEntry(root, (entry) => {
    if (!budget()) return false;
    if (!entry.isDirectory()) return true;
    const dir = join(root, entry.name);
    if (
      !forEachDirEntry(dir, (file) => {
        if (!budget()) return false;
        if (file.name.endsWith(".jsonl")) files.push(join(dir, file.name));
        return true;
      })
    )
      complete = false;
    return complete;
  });
  return read && complete ? files : null;
}

function transcriptAbsent(record: LaunchRecord, started: number): boolean {
  const session = record.sessionId as string;
  const deadline = Date.now() + 200;
  const files = transcriptFiles(record.configDir, deadline);
  if (files === null) return false;
  try {
    for (const path of files) {
      if (Date.now() >= deadline) return false;
      if (basename(path) === `${session}.jsonl`) return false;
      if (statSync(path).mtimeMs < started) continue;
      // A large file whose beginning is outside the tail cannot prove absence.
      if (statSync(path).size > 256 * 1024) return false;
      if (readBoundedTail(path, 256 * 1024).includes(session)) return false;
    }
    return true;
  } catch (error) {
    swallow(error, "the session's transcript absence could not be confirmed");
    return false;
  }
}

/** Only a recognized standalone vendor notice is persisted, never arbitrary output. */
function quotaNotice(output: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    const parts = line.trim().split("·");
    if (parts.length !== 2) return false;
    return (
      /^you(?:'|’)ve hit your (?:session |weekly |usage )?limit$/i.test(
        (parts[0] ?? "").trim(),
      ) && /^resets\s+\S/i.test((parts[1] ?? "").trim())
    );
  });
}

export function failedStartup(
  record: LaunchRecord,
  code: number | null,
  started: number,
  output: string,
  exited: number,
): "quota" | "unstarted" | undefined {
  if (
    record.action !== "followup" ||
    record.vendor !== "claude" ||
    typeof record.sessionId !== "string" ||
    code === null ||
    code === 0 ||
    exited - started > STARTUP_MS ||
    !transcriptAbsent(record, started)
  )
    return;
  return quotaNotice(output) ? "quota" : "unstarted";
}

/** Persisted startup evidence permits only the follow-up attempt that never began to retry. */
export function retryableStartup(r: ReadRecord): boolean {
  return (
    r.record.action === "followup" &&
    r.result === null &&
    r.state.kind === "ended" &&
    (r.state.exit.startup === "quota" || r.state.exit.startup === "unstarted")
  );
}

/** The ids of retryable startups whose end no later row has settled. */
export function unsettledStartups(
  records: ReadRecord[],
  settled: Set<string>,
): string[] {
  return records
    .filter((r) => retryableStartup(r) && !settled.has(r.record.id))
    .map((r) => r.record.id);
}
