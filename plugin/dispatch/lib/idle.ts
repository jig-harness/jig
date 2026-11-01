/**
 * Since when each claimed item has had no running session, under
 * `~/.local/state/jig/dispatch/idle/`: one small file per item, written the
 * first tick that finds the item claimed (in its in-progress state) with no
 * running session and no launch record holding it, and removed the first
 * tick that finds a session for it again or the item no longer claimed. A
 * claimed item idle for longer than `dispatch.stalled_after` is a stalled
 * pickup: reported, never relaunched. The clock starts when a tick first
 * sees the item idle, so a tick that did not run meanwhile reports it late,
 * never early.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";
import { stateRoot } from "../receipts.ts";

function idleRoot(root: string): string {
  return join(root, "idle");
}

function fileOf(repo: string, item: string, root: string): string {
  const stem = createHash("sha256")
    .update(`${repo}\n${item}`)
    .digest("hex")
    .slice(0, 32);
  return join(idleRoot(root), `${stem}.json`);
}

interface IdleEntry {
  repo: string;
  item: string;
  since: number;
}

function entries(root: string): Array<IdleEntry & { path: string }> {
  let names: string[];
  try {
    names = readdirSync(idleRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Array<IdleEntry & { path: string }> = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const path = join(idleRoot(root), name);
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        isMapping(value) &&
        typeof value.repo === "string" &&
        typeof value.item === "string" &&
        typeof value.since === "number"
      )
        found.push({
          repo: value.repo,
          item: value.item,
          since: value.since,
          path,
        });
    } catch (error) {
      swallow(error, `${path} does not read`);
    }
  }
  return found;
}

/** Since when each of `repo`'s claimed items has been idle, in milliseconds. */
export function readIdle(
  repo: string,
  root = stateRoot(),
): Map<string, number> {
  return new Map(
    entries(root)
      .filter((e) => e.repo === repo)
      .map((e) => [e.item, e.since]),
  );
}

/**
 * Start the clock of each item idle now that has none, and stop the clock
 * of every other item of `repo`.
 */
export function updateIdle(
  repo: string,
  idleNow: ReadonlyArray<string>,
  nowMs: number,
  root = stateRoot(),
): void {
  const idle = new Set(idleNow);
  const kept = new Set<string>();
  for (const entry of entries(root)) {
    if (entry.repo !== repo) continue;
    if (idle.has(entry.item)) kept.add(entry.item);
    else rmSync(entry.path, { force: true });
  }
  const fresh = [...idle].filter((item) => !kept.has(item));
  if (fresh.length === 0) return;
  mkdirSync(idleRoot(root), { recursive: true, mode: 0o700 });
  for (const item of fresh)
    writeFileSync(
      fileOf(repo, item, root),
      `${JSON.stringify({ repo, item, since: nowMs })}\n`,
      { mode: 0o600 },
    );
}
