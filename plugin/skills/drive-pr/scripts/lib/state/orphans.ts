/**
 * The one-time warning about a worktree-private state file orphaned by the
 * git-common-dir migration.
 *
 * A drive already in flight when the `--git-common-dir` fix landed has its
 * state in the worktree-PRIVATE `.git/worktrees/<name>/`, which the store now
 * never reads. Observed immediately after that fix merged: the first call
 * found nothing and returned a fresh drive, round count and verified SHA gone.
 *
 * An absent file is a LEGITIMATE fresh start, so this cannot be an error —
 * which is exactly what makes the loss silent, and what makes a parked human
 * decision the worst thing in it. So: say so, once, loudly, and leave the
 * move to a human. Adopting the orphan automatically would have to answer
 * "which wins" when both exist, and guessing that overwrites a parked
 * decision rather than merely forgetting one. Skipped when
 * $DRIVE_PR_STATE_DIR is set: the caller named the directory, so there is no
 * migration to have missed (`store.ts` owns that gate).
 */

import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stderrIsDevNull } from "../cli.ts";

/** A concrete command whose only shell-quoted argument contains encoded paths. */
export function recoveryCommand(source: string, destination: string): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  const module = encode(new URL("../../portable.ts", import.meta.url).href);
  return `bun -e "const d=s=>Buffer.from(s,'base64url').toString('utf8');const m=await import(d('${module}'));m.recoverState(d('${encode(source)}'),d('${encode(destination)}'))"`;
}

/** Every worktree-private `drive-pr-<pr>.json` under the common git dir.
 *
 * EVERY worktree-private git dir is searched, not just the CURRENT worktree's.
 * Before the common-dir migration, any linked worktree could hold its own
 * state file — checking only this worktree's git dir means resuming the drive
 * from a *different* worktree than the one that held it reports a silent
 * fresh start, because the one place this loop looked has nothing there.
 * `<stateDir>/worktrees/*` is where git places every linked worktree's
 * private dir, so it is the complete search — the first worktree of a clone
 * has no separate private dir at all (its git-dir IS the common dir), so it
 * needs no entry here. */
function findOrphans(stateDir: string, pr: string): string[] {
  const orphans: string[] = [];
  const worktrees = join(stateDir, "worktrees");
  if (!existsSync(worktrees)) return orphans;
  let entries: string[] = [];
  try {
    entries = readdirSync(worktrees).sort();
  } catch {
    return orphans;
  }
  for (const entry of entries) {
    const cand = join(worktrees, entry, `drive-pr-${pr}.json`);
    if (existsSync(cand)) orphans.push(cand);
  }
  return orphans;
}

/**
 * Warn — once, durably, delivery-aware — when orphans exist for this PR.
 *
 * "Once" needs its own durable marker, or this fires on every invocation that
 * reads state without writing it — `rounds`, `get`, `parked-keys` never
 * create the state file, and drive-status calls `parked-keys` on every
 * evaluation, so an unattended loop would repeat this warning every round
 * until a human happened to notice and act. The marker lives beside the state
 * files this warning is about, not in the state file itself: writing INTO the
 * thing that does not exist yet would conflate "acknowledged" with "adopted"
 * the moment a normal fresh drive starts writing there. It naturally goes
 * stale either way the file stops being absent — adopting an orphan or
 * starting a fresh drive both end the condition this guards — and `reset`
 * clears it explicitly for the one path where the file disappears again
 * without either of those happening.
 *
 * Claimed ATOMICALLY: the exclusive-create (`wx`) makes the write itself fail
 * when the marker already exists, so two concurrent evaluations racing this
 * check-then-act cannot both win it and both print — only the one whose
 * create actually lands does. An exists-check followed by a plain create here
 * would be exactly the race `lock.ts` exists to avoid elsewhere.
 *
 * And the claim is DELIVERY-AWARE, not merely atomic. The create has to come
 * first to serialise, but a process killed between the create and the first
 * write to stderr would then leave a marker saying "warned" for a warning
 * nobody ever saw — silently trading the one notification that an orphan may
 * hold parked human decisions for a file. So the create only RESERVES (empty
 * file), the delivered sentinel is written after the last line, and a marker
 * found empty is treated as unclaimed and re-warned.
 *
 * The two failure directions are not symmetric, which is what settles the
 * design: re-warning costs a repeated paragraph on stderr, while not warning
 * costs the parked decisions. When "never duplicate" and "never lose"
 * conflict, this fails toward warning again.
 *
 * And "delivered" is judged against the CHANNEL, not just against reaching
 * the write. A caller running us with stderr on the null device gets the
 * warning written into the void while the marker records it as seen; every
 * later human-visible call then stays silent. drive-status was one such
 * caller and was fixed directly, but that was the instance, not the class —
 * `round-plan.ts --delta` silences `drive-state.ts verified` the same way,
 * and any future caller may. So the test is on fd 2 itself: device+inode
 * comparison recognises /dev/null however the caller spelled the redirect,
 * while a log file or a pipe still counts as delivered — and an unanswerable
 * comparison reads as deliverable, so the guard cannot silence itself.
 */
export function warnAboutOrphans(
  stateDir: string,
  file: string,
  pr: string,
): void {
  const orphans = findOrphans(stateDir, pr);
  if (orphans.length === 0) return;
  if (stderrIsDevNull()) {
    // Nowhere to deliver it. Say nothing and claim nothing, so the first
    // caller whose stderr a human can actually read still gets the warning.
    return;
  }
  // Built by the exported helper, not spelled a second time: `reset` clears
  // the marker through that helper, so a drifting literal here would leave the
  // one-time warning permanently disarmed.
  // Declared below, but a hoisted function declaration, so this call is fine.
  const warned = orphanMarkerPath(stateDir, pr);
  // An UNDELIVERED reservation (empty marker) is recoverable, but not by
  // delete + create: two processes can both see it empty, and after the first
  // removes it and claims a fresh one, the second's already-authorised delete
  // removes that live reservation and claims the path itself — both then
  // print the supposedly one-time warning. Broken by RENAME instead, exactly
  // as `lock.ts` breaks a stale lock and for the same reason: a rename is
  // atomic and fails for the loser, so only one process ever removes any
  // given reservation, and it then contends for the new one on equal terms.
  try {
    if (existsSync(warned) && statSync(warned).size === 0) {
      const abandoned = `${warned}.abandoned.${process.pid}`;
      renameSync(warned, abandoned);
      rmSync(abandoned, { force: true });
    }
  } catch {
    // the loser of the rename race; the winner recovers the reservation
  }
  let claimed = false;
  try {
    writeFileSync(warned, "", { flag: "wx" });
    claimed = true;
  } catch {
    claimed = false;
  }
  if (!claimed) return;

  // A native Bun operation publishes exclusively before removing the old path.
  // Its hard link refuses a destination another driver created in the meantime.
  const recover = (source: string) => recoveryCommand(source, file);
  const onlyOrphan = orphans.length === 1 ? orphans[0] : undefined;
  if (onlyOrphan !== undefined) {
    console.error(
      `drive-state.ts: no state at ${file}, but a worktree-private one exists:`,
    );
    console.error(`  ${onlyOrphan}`);
    console.error(
      "It predates drive state moving to the clone-wide git dir. Starting fresh",
    );
    console.error(
      "here DISCARDS its round budget and any PARKED HUMAN DECISIONS it holds.",
    );
    console.error(`  To adopt it:  ${recover(onlyOrphan)}`);
    console.error(
      "  (Recovery refuses rather than clobbering state another driver",
    );
    console.error("   may have created since this warning was printed.)");
  } else {
    console.error(
      `drive-state.ts: no state at ${file}, but ${orphans.length} worktree-private`,
    );
    console.error(
      "candidates exist — starting fresh here DISCARDS whichever holds the round",
    );
    console.error(
      "budget and any PARKED HUMAN DECISIONS. Inspect each and adopt the right one:",
    );
    for (const orphan of orphans) {
      console.error(`  ${orphan}`);
      console.error(`    ${recover(orphan)}`);
    }
    console.error(
      "  (Recovery refuses rather than clobbering state another driver",
    );
    console.error("   may have created since this warning was printed.)");
  }
  // DELIVERED. Only now is the reservation above a real acknowledgement;
  // until this write lands the marker is empty and the next run re-warns.
  try {
    writeFileSync(warned, "delivered\n");
  } catch {
    // best-effort, like the bash `|| true`
  }
}

/** The marker `reset` clears so a later recurrence of the condition re-arms. */
export function orphanMarkerPath(stateDir: string, pr: string): string {
  return join(stateDir, `.drive-pr-${pr}.orphan-warned`);
}
