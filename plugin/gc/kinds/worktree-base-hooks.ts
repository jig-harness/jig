/** The base branch's remove hook, extracted for collection. */
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { spawnSync } from "../../shared/guarded-git-spawn.ts";
import { HOOKS_DIR, hookPath } from "../../shared/worktree-hooks.ts";
import { gcGit as git, gitEnvironment } from "../git.ts";
/**
 * The base-branch commit's hooks directory, extracted to a directory of its
 * own: collection runs that copy, never the retiring branch's, so the hook and
 * the files beside it are the bytes the base branch holds, which a branch
 * cannot change. A helper a hook starts from the checkout, and the checkout's
 * Bun startup file, are the branch's own: a `bunfig.toml` that differs from the
 * base branch's is refused, since it could preload code into the hook's Bun.
 * The base commit decides whether a hook exists: null when neither it nor the
 * checkout holds one.
 */
export async function snapshotBaseHooks(
  repository: string,
  declaration: string,
  worktree: string,
): Promise<Outcome<{ hook: string; dir: string } | null>> {
  const tip = / @ ([0-9a-f]{40,64})$/.exec(declaration)?.[1];
  if (tip === undefined)
    return failed(
      "unknown-base",
      "the base-branch commit of the declaration is unknown",
    );
  const held = await git(repository, [
    "ls-tree",
    "--name-only",
    tip,
    "--",
    `${HOOKS_DIR}/remove`,
  ]);
  if (!held.ok) return held;
  if (held.value === "") {
    // The base branch decides whether a teardown is required; a checkout that
    // brings a hook of its own the base never reviewed is still refused.
    if (hookPath(worktree, "remove") === null) return ok(null);
    return failed(
      "unreviewed-hook",
      `kept: ${HOOKS_DIR}/remove is not in the base branch, so its code was never reviewed there`,
    );
  }
  const startup = await requireBaseBunfig(repository, tip, worktree);
  if (!startup.ok) return startup;
  const dir = mkdtempSync(join(tmpdir(), "jig-gc-hooks-"));
  const hook = join(dir, HOOKS_DIR, "remove");
  let extracted: Outcome<undefined>;
  try {
    extracted = await extractBaseHooks(repository, tip, dir);
    if (extracted.ok) accessSync(hook, constants.X_OK);
  } catch (error) {
    extracted = failed(
      "hook-unrunnable",
      `kept: the base branch's ${HOOKS_DIR}/remove cannot run (${error instanceof Error ? error.message : String(error)})`,
      error,
    );
  }
  if (!extracted.ok) {
    rmSync(dir, { recursive: true, force: true });
    return extracted;
  }
  return ok({ hook, dir });
}
/** Refuse a checkout whose Bun startup file is not the base branch's. */
async function requireBaseBunfig(
  repository: string,
  tip: string,
  worktree: string,
): Promise<Outcome<undefined>> {
  const startup = join(worktree, "bunfig.toml");
  if (!existsSync(startup)) return ok(undefined);
  const local = await git(repository, ["hash-object", "--no-filters", startup]);
  if (!local.ok) return local;
  // A base branch without the file, or one git cannot read, holds no match.
  const base = await git(repository, ["rev-parse", `${tip}:bunfig.toml`]).then(
    (read) => (read.ok ? read.value : ""),
    () => "",
  );
  if (local.value !== base)
    return failed(
      "startup-differs",
      "kept: bunfig.toml differs from the base branch's; remove the worktree by hand",
    );
  return ok(undefined);
}
/**
 * Extract the commit's hooks directory into `dir`, then check every committed
 * file as extracted: `git archive` honours export-ignore and export-subst, and
 * what runs must be the committed bytes.
 */
async function extractBaseHooks(
  repository: string,
  tip: string,
  dir: string,
): Promise<Outcome<undefined>> {
  const env = gitEnvironment() as Record<string, string>;
  const archive = join(dir, "hooks.tar");
  const spawned: [string, string[]][] = [
    [
      "git",
      [
        "--no-replace-objects",
        "-C",
        repository,
        "archive",
        "--format=tar",
        "-o",
        archive,
        tip,
        "--",
        HOOKS_DIR,
      ],
    ],
    ["tar", ["-xf", archive, "-C", dir]],
  ];
  for (const [file, args] of spawned) {
    const done = spawnSync(file, args, { env, timeout: 60_000 });
    if (done.status !== 0)
      return failed(
        "hook-unrunnable",
        `could not extract ${HOOKS_DIR} from the base branch`,
      );
  }
  const listed = await git(repository, [
    "ls-tree",
    "-r",
    "-z",
    tip,
    "--",
    HOOKS_DIR,
  ]);
  if (!listed.ok) return listed;
  for (const row of listed.value.split("\0").filter((entry) => entry !== "")) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (match === null)
      return failed(
        "hook-unrunnable",
        `kept: ${HOOKS_DIR} in the base branch holds an entry that is not a plain file`,
      );
    const [, , oid, path] = match;
    const extracted = join(dir, path ?? "");
    if (!existsSync(extracted))
      return failed(
        "hook-unrunnable",
        `kept: ${path} was changed or left out by git archive's export attributes`,
      );
    const hashed = await git(repository, [
      "hash-object",
      "--no-filters",
      extracted,
    ]);
    if (!hashed.ok) return hashed;
    if (hashed.value !== oid)
      return failed(
        "hook-unrunnable",
        `kept: ${path} was changed or left out by git archive's export attributes`,
      );
  }
  return ok(undefined);
}
