/**
 * The evidence that a pass's own end could not be written on this host:
 * `jig dispatch result` whose write the state database refused (a schema out
 * of step with its version, a locked or broken file), or the wrapper that
 * could not record the stage's exit. It is a file outside the database,
 * `<dispatch>/unwritten/<record>.json`, so it survives the fault it records,
 * and the tick reads it with the record once the database reads again
 * (`readLaunches`), as the record's `unwritten`.
 *
 * The file holds the SHA-256 of the record's token, which the writer was
 * handed and cannot check while the database refuses it: the tick reads the
 * evidence only when that digest is the record's own, so no other process
 * can make a record owe a run again. The first file written stands; it goes
 * when its record is pruned.
 *
 * What the tick does with it: a follow-up whose record has no result and
 * this evidence is run again once (`session-startup.ts`), and neither a
 * follow-up's nor a pickup's question is raised to a person from that pass:
 * the fault is the host's, and its health check reports it.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { LAUNCH_RECORD_ID } from "../../shared/records/launch-claims.ts";

/** What was not written: the pass's result, or the stage's exit. */
export type UnwrittenWhat = "result" | "exit";

function unwrittenPath(root: string, id: string): string {
  return join(root, "unwritten", `${id}.json`);
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Keep the evidence that record `id`'s end could not be written, best
 * effort: `false` when the id is not a record id's shape or the file could
 * not be written either. An earlier file stands.
 */
export function writeUnwritten(
  root: string,
  id: string,
  token: string,
  what: UnwrittenWhat,
  why: string,
): boolean {
  if (!LAUNCH_RECORD_ID.test(id)) return false;
  const path = unwrittenPath(root, id);
  if (existsSync(path)) return true;
  try {
    mkdirSync(join(root, "unwritten"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const body = {
      version: 1,
      record: id,
      token: digest(token),
      what,
      at: new Date().toISOString(),
      why: why.replace(/\s+/g, " ").trim().slice(0, 500),
    };
    writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch (error) {
    swallow(error, "the evidence of an unwritten end could not be kept");
    return false;
  }
}

/**
 * When record `id`'s end could not be written, as its evidence says, when
 * the evidence names the record's own token: `{ unwritten: <time> }`, else
 * nothing, for a spread into the record as read.
 */
export function unwrittenOf(
  root: string,
  id: string,
  token: string,
): { unwritten?: string } {
  const path = unwrittenPath(root, id);
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMapping(value) &&
      value.record === id &&
      value.token === digest(token) &&
      typeof value.at === "string"
      ? { unwritten: value.at }
      : {};
  } catch (error) {
    swallow(error, "the evidence of an unwritten end does not read");
    return {};
  }
}

/** Remove the evidence of records that were pruned. */
export function removeUnwritten(root: string, ids: readonly string[]): void {
  for (const id of ids)
    if (LAUNCH_RECORD_ID.test(id))
      rmSync(unwrittenPath(root, id), { force: true });
}
