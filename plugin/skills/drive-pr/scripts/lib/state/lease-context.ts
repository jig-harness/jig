/**
 * The context the mutation fences (`lease-fence.ts`) judge in: this
 * session, this tree, the clone's state directory, and the database it
 * stands for, identified.
 *
 * A pass a driver spawned inherits the driver's clone directory as
 * `$DRIVE_PR_STATE_DIR` and the database's instance id as
 * `$DRIVE_PR_STATE_DIR_IDENTITY` (`db.ts`'s `driveDbInstance`). The fence
 * refuses a post when the database beside that directory is not the one
 * the driver opened (deleted and created again, or another file in its
 * place), since a lease the driver's successor holds would not be in it,
 * and when an override arrives without the identity at all. A session that
 * set no override resolves its own clone and reads the identity once, then
 * checks it again right before it authorizes the act.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lstatSync } from "node:fs";
import { fail } from "../cli.ts";
import { git, gitCallTimeoutSeconds } from "../proc.ts";
import { resolveActor } from "./actor.ts";
import { peekCloneKey } from "./clone-key.ts";
import { DB_FILE, driveDbInstance } from "./db.ts";
import { resolveSession, type Session } from "./lease-model.ts";
import { peekResolvedStateDir } from "./store.ts";

/** What the fences judge in. */
export interface FenceContext {
  stateDir: string;
  actor: string;
  session: Session;
  /** The database's instance id, which must not change before the act. */
  instance: string;
}

/**
 * Whether the working directory is inside a repository after all: an
 * inherited `GIT_DIR`, or a `.git` entry somewhere up the tree. Read from
 * the filesystem, not git's exit status, since 128 is git's generic fatal
 * status and covers dubious ownership and corruption too.
 */
function repositoryIsInPlay(): boolean {
  for (const v of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) {
    if ((process.env[v] ?? "") !== "") return true;
  }
  let dir = resolve(process.cwd());
  for (;;) {
    try {
      lstatSync(join(dir, ".git"));
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * The fence context, or `null` when there is no drive state anywhere for a
 * lease to sit in: outside a repository, or in a clone that has never been
 * driven (it has no clone identity yet). A repository whose clone cannot be
 * resolved refuses (exit 1): whether another session holds its lease is then
 * unknown, in front of an act that cannot be withdrawn.
 */
export async function resolveFenceContext(
  label: string,
): Promise<FenceContext | null> {
  const session = resolveSession(label);
  const override = process.env.DRIVE_PR_STATE_DIR ?? "";
  if (override !== "" && !isAbsolute(override)) {
    fail(
      2,
      `${label}: $DRIVE_PR_STATE_DIR must be an absolute path, got: ${override}`,
      "A relative override resolves against the current working directory,",
      "so two participants launched from different directories (the base",
      "checkout and a linked worktree, in particular) would silently fence",
      "against two different state directories.",
    );
  }
  if (override !== "") return await inheritedContext(label, override, session);
  const commonDir = await commonDirOrNull(label);
  if (commonDir === null) return null;
  if (peekCloneKey(commonDir) === null) return null;
  const stateDir = await peekResolvedStateDir();
  if (stateDir === null) return null;
  return {
    stateDir,
    actor: await resolveActor(),
    session,
    instance: driveDbInstance(stateDir),
  };
}

/** The clone's Git common directory, `null` outside a repository, a refusal when git cannot say. */
async function commonDirOrNull(label: string): Promise<string | null> {
  const r = await git(["rev-parse", "--git-common-dir"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  const dir = r.code === 0 ? r.stdout.trim() : "";
  if (dir !== "") return resolve(dir);
  if (!r.timedOut && !repositoryIsInPlay()) return null;
  return fail(
    1,
    `${label}: git could not say where this clone's drive state lives (${r.timedOut ? "timed out" : r.code === 0 ? "exited 0 but named no directory" : `exited ${r.code}`}), and this IS a repository — so whether another session has taken its drive lease is unknown.`,
    "Refusing to post rather than answer that question by assuming: an outcome",
    "reply cannot be withdrawn once it is on the thread.",
    "",
    "Being outside a repository is a different case and still posts — there is",
    "no drive state anywhere for a lease to sit in. It is established from the",
    "filesystem, not from git's exit status, because 128 is git's generic fatal",
    "status and covers dubious ownership and corruption as well.",
  );
}

/** The context a pass inherits from its driver: the override must name a clone and carry its database's identity. */
async function inheritedContext(
  label: string,
  override: string,
  session: Session,
): Promise<FenceContext> {
  const leaf = resolve(override);
  const stateDir = /^[0-9a-f]{16}$/.test(basename(leaf))
    ? leaf
    : await peekResolvedStateDir();
  const expected = process.env.DRIVE_PR_STATE_DIR_IDENTITY ?? "";
  if (expected === "") {
    fail(
      1,
      `${label}: $DRIVE_PR_STATE_DIR is set but $DRIVE_PR_STATE_DIR_IDENTITY is not:`,
      `  ${override}`,
      "",
      "Refusing to post. A state-directory override asserts a drive resolved this",
      "path, and every current driver exports its database's identity beside it —",
      "so an override arriving without one means this pass cannot tell whether the",
      "database was replaced before it started. Re-run through a current",
      "drive.ts, or unset $DRIVE_PR_STATE_DIR to use the ordinary path.",
    );
  }
  if (stateDir === null) {
    return fail(
      1,
      `${label}: the inherited drive state directory names no clone this repository has:`,
      `  ${override}`,
      "",
      "Refusing to post: whether another session holds this tree's lease is unknown.",
    );
  }
  const context = {
    stateDir,
    actor: await resolveActor(),
    session,
    instance: driveDbInstance(stateDir),
  };
  assertSameDatabase(label, context, expected, "when this pass started");
  return context;
}

/**
 * Refuse (exit 1) when the database beside the context's state directory is
 * not the one with instance `expected`.
 */
export function assertSameDatabase(
  label: string,
  ctx: FenceContext,
  expected: string,
  when: string,
): void {
  const now = driveDbInstance(ctx.stateDir);
  if (now === expected) return;
  fail(
    1,
    `${label}: the drive's database is not the one ${when === "when this pass started" ? "this drive opened" : "this check read"} (${when}):`,
    `  ${join(dirname(ctx.stateDir), DB_FILE)}`,
    "",
    "Refusing to post. A database deleted and created again, or another file in",
    "its place, does not hold the leases the drive's other sessions took, so",
    "reading no lease there is not evidence that nobody is driving. An outcome",
    "reply has no undo, so this refuses rather than trust that read.",
  );
}
