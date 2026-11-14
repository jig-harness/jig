/**
 * The evidence that a pass's own end could not be written on this host:
 * `jig dispatch result` whose write the state database refused (a schema out
 * of step with its version, a locked or broken file), or the wrapper that
 * could not record the stage's exit. It is a file outside the database,
 * `<dispatch>/unwritten/<record>.<token digest>.json`, so it survives the
 * fault it records,
 * and the tick reads it with the record once the database reads again
 * (`readLaunches`), as the record's `unwritten`.
 *
 * The files are named, and hold, the SHA-256 of the record's token, which the
 * writer was handed and cannot check while the database refuses it: the tick
 * reads only files of the record's own digest, so no other process can make a
 * record owe a run again, nor keep the genuine pass's evidence out with a
 * file of its own. Result evidence and the wrapper's exit witness have
 * separate files, so the latter can record cleanup after a refused result
 * write. Every file of a record goes when the record is pruned.
 *
 * What the tick does with it: a follow-up whose record has no result and
 * this evidence is run again once (`session-startup.ts`), and neither a
 * follow-up's nor a pickup's question is raised to a person from that pass:
 * the fault is the host's, and its health check reports it.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { currentIso } from "../../shared/time.ts";
import { LAUNCH_RECORD_ID } from "../../shared/records/launch-claims.ts";

/** What was not written: the pass's result, or the stage's exit. */
export type UnwrittenWhat = "result" | "exit";

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The evidence file of record `id` under the token whose digest is `hash`. */
function unwrittenPath(
  root: string,
  id: string,
  hash: string,
  what: UnwrittenWhat,
): string {
  return join(root, "unwritten", `${id}.${hash}.${what}.json`);
}

/** The filename written before result and exit evidence were kept separately. */
function legacyUnwrittenPath(root: string, id: string, hash: string): string {
  return join(root, "unwritten", `${id}.${hash}.json`);
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
  const hash = digest(token);
  const path = unwrittenPath(root, id, hash, what);
  if (existsSync(path)) return true;
  try {
    mkdirSync(join(root, "unwritten"), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const body = {
      version: 1,
      record: id,
      token: hash,
      what,
      at: currentIso(),
      why: why.replace(/\s+/g, " ").trim().slice(0, 500),
    };
    writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    // `rename` replaces an existing destination on POSIX. Linking the
    // completed temporary file instead gives the first publisher ownership.
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (!existsSync(path)) throw error;
    } finally {
      unlinkSync(temporary);
    }
    return true;
  } catch (error) {
    swallow(error, "the evidence of an unwritten end could not be kept");
    return false;
  }
}

/** The time in a valid evidence file under one of `paths`, optionally of `what`. */
function evidenceAt(
  paths: readonly string[],
  id: string,
  hash: string,
  what?: UnwrittenWhat,
): string | undefined {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        isMapping(value) &&
        value.record === id &&
        value.token === hash &&
        typeof value.at === "string" &&
        (what === undefined || value.what === what)
      )
        return value.at;
    } catch (error) {
      swallow(error, "the evidence of an unwritten end does not read");
    }
  }
  return undefined;
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
  const hash = digest(token);
  const at = evidenceAt(
    [
      unwrittenPath(root, id, hash, "result"),
      unwrittenPath(root, id, hash, "exit"),
      legacyUnwrittenPath(root, id, hash),
    ],
    id,
    hash,
  );
  return at === undefined ? {} : { unwritten: at };
}

/**
 * Whether the evidence of record `id` under its own token says the stage's
 * exit could not be written. The wrapper keeps it only after its stage's
 * processes were confirmed ended, so it witnesses the cleanup a supervised
 * launch's claim cannot show once the wrapper is gone.
 */
export function unwrittenExitWitness(
  root: string,
  id: string,
  token: string,
): boolean {
  const hash = digest(token);
  return (
    evidenceAt(
      [
        unwrittenPath(root, id, hash, "exit"),
        legacyUnwrittenPath(root, id, hash),
      ],
      id,
      hash,
      "exit",
    ) !== undefined
  );
}

/** Remove every evidence file of the records that were pruned, best effort: a file left behind is read by nothing, since its record is gone. */
export function removeUnwritten(root: string, ids: readonly string[]): void {
  const pruned = new Set(ids);
  if (pruned.size === 0) return;
  const dir = join(root, "unwritten");
  try {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const id = name.split(".")[0] ?? "";
      if (pruned.has(id) && LAUNCH_RECORD_ID.test(id))
        rmSync(join(dir, name), { force: true });
    }
  } catch (error) {
    swallow(error, "the evidence of a pruned record could not be removed");
  }
}
