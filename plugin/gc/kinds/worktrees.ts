/** Inventory is safe without the session opener's lifecycle and lock protocol. */
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isMapping } from "../../shared/config-layers.ts";
import {
  orcaEnvelope,
  orcaFailure,
  orcaResult,
  runOrca,
} from "../../shared/orca.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run } from "../../shared/proc.ts";
import { spawnSync } from "../../shared/guarded-git-spawn.ts";
import { HOOKS_DIR, hookPath } from "../../shared/worktree-hooks.ts";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { gcGit as git, gitEnvironment } from "../git.ts";
import { localSteps, removeThroughOrca } from "../worktree-removal.ts";
import { processHolder } from "./worktree-git.ts";
import {
  type Collected,
  guardedCollection,
  LAUNCH_VETO,
} from "./worktree-guard.ts";
import {
  markingSince,
  type Archived,
  type ArchivePolicy,
  type LegacyPolicy,
} from "../legacy-archive.ts";
import {
  canonicalWorktree,
  orcaLiveness,
  preserveLegacyContent,
  runtimeWorktreeProof,
  worktreePolicy,
  worktreeProof,
  type WorktreePolicy,
} from "./worktree-proof.ts";
import type { CollectionKind, Resource } from "../types.ts";

/** Seconds `orca worktree rm` may take: it deletes the checkout's files. */
const ORCA_REMOVE_TIMEOUT_SEC = 300;
/** The time a removal through Orca may take: the remove hook, the park and the removal. */
const ORCA_REMOVAL_LIMIT_MS = 30 * 60_000;
/** The time the one-time archive of a worktree's ignored content may take. */
const ARCHIVE_LIMIT_MS = 5 * 60_000;

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}
/** A worktree Orca manages: its id, and its path exactly as Orca reports it. */
interface OrcaWorktree {
  id: string;
  path: string;
}
/**
 * The worktrees Orca manages in `repository`, by path as git spells it, with
 * Orca's id and path of each; empty when Orca has no such repository. A list
 * Orca cannot give in full fails the inventory: a checkout it manages must
 * not pass for a plain one.
 */
async function orcaWorktrees(
  command: string,
  repository: string,
): Promise<Outcome<Map<string, OrcaWorktree>>> {
  const done = await runOrca(command, [
    "worktree",
    "list",
    "--repo",
    `path:${repository}`,
    "--json",
  ]);
  const envelope = orcaEnvelope(done.stdout);
  if (envelope?.ok === false && envelope.code === "repo_not_found")
    return ok(new Map());
  const result = orcaResult(done);
  if (result === null)
    return failed(
      "orca-unreadable",
      `Orca's worktree list could not be read ${orcaFailure(done)}`,
    );
  if (result.truncated !== false || !Array.isArray(result.worktrees))
    return failed(
      "malformed",
      "Orca's worktree list was incomplete or malformed",
    );
  const managed = new Map<string, OrcaWorktree>();
  for (const row of result.worktrees) {
    if (
      !isMapping(row) ||
      typeof row.id !== "string" ||
      typeof row.path !== "string"
    )
      return failed("malformed", "Malformed Orca worktree record");
    managed.set(canonicalWorktree(row.path), { id: row.id, path: row.path });
  }
  return ok(managed);
}
function orcaId(resource: Resource): string | null {
  return isMapping(resource.details) &&
    resource.details.runtime === "orca" &&
    typeof resource.details.orca === "string"
    ? resource.details.orca
    : null;
}
/** The worktree's path exactly as Orca reports it: what its guard key is taken of. */
function orcaPath(resource: Resource): string | null {
  return isMapping(resource.details) &&
    typeof resource.details.orcaPath === "string"
    ? resource.details.orcaPath
    : null;
}
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
async function snapshotBaseHooks(
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
/**
 * Collect a worktree Orca manages through Orca: the repository's remove hook
 * inside it, its reflection findings parked, then `orca worktree rm`, so its
 * card, terminals and agent records go with it. Never `git worktree remove`.
 */
async function collectThroughOrca(
  command: string,
  resource: Resource,
  orcaWorktree: { id: string; launched: () => string | null },
  repository: string,
  declaration: string,
  legacy: LegacyPolicy | undefined,
): Promise<Collected> {
  const { id, launched } = orcaWorktree;
  let archived: Archived | null = null;
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  const failure = (outcome: { failure: { code: string; reason: string } }) => ({
    outcome:
      outcome.failure.code === LAUNCH_VETO
        ? ("refused" as const)
        : ("failed" as const),
    reason: outcome.failure.reason,
  });
  let snapshot: { hook: string; dir: string } | null = null;
  try {
    // The retiring branch supplies the hook, and this runs unattended, so the
    // hook that runs is the declared base-branch commit's, never the branch's.
    const taken = await snapshotBaseHooks(repository, declaration, resource.id);
    if (!taken.ok) return failure(taken);
    snapshot = taken.value;
    const base = snapshot;
    const removed = await removeThroughOrca({
      worktree: resource.id,
      id,
      force: false,
      orca: (args) =>
        run([command, ...args, "--json"], {
          timeoutSec: ORCA_REMOVE_TIMEOUT_SEC,
        }),
      log,
      steps: {
        ...localSteps(Date.now() + ORCA_REMOVAL_LIMIT_MS, log),
        hook: () => base?.hook ?? null,
        // The hook may run for minutes: Orca can start an agent meanwhile, and
        // the hook can leave a process in the checkout that outlives it.
        admit: async (worktree) => {
          const checks = async (): Promise<Outcome<undefined, string>> => {
            const live = await orcaLiveness(command, worktree);
            if (live !== null)
              return failed("live", `kept after the hook: ${live.reason}`);
            // Read after the registry and after gc's admission: a launch the
            // plugin let through meanwhile left its marker first.
            const launch = launched();
            if (launch !== null)
              return failed(LAUNCH_VETO, `kept after the hook: ${launch}`);
            if ((await processHolder(worktree)) !== false)
              return failed(
                "held",
                "kept after the hook: a process holds the worktree, or holders could not be read",
              );
            return ok(undefined);
          };
          const before = await checks();
          if (!before.ok) return before;
          // Last, so the archive holds the content as the removal finds it.
          const preserved = await preserveLegacyContent(
            worktree,
            legacy,
            Date.now() + ARCHIVE_LIMIT_MS,
          );
          if (!preserved.ok) return preserved;
          // Named on every failure from here on.
          archived = preserved.value;
          // The archive may have run for minutes: an agent or process can
          // have started meanwhile, so what removal relies on is read again.
          const after = await checks();
          if (!after.ok) return after;
          return ok(undefined);
        },
      },
    });
    // An archive written before a step that then failed stays, named in the
    // receipt, and expires with the receipts.
    if (!removed.ok)
      return archived === null
        ? failure(removed)
        : { ...failure(removed), details: { archive: archived } };
    return {
      outcome: "collected",
      reason: `removed through Orca: ${removed.value.hook === null ? `no ${HOOKS_DIR}/remove` : `ran ${HOOKS_DIR}/remove`}, parked reflection findings,${archiveNote(archived)} orca worktree rm`,
      details: {
        ...(isMapping(resource.details) ? resource.details : {}),
        hook: removed.value.hook,
        parked: true,
        ...(archived === null ? {} : { archive: archived }),
      },
    };
  } catch (error) {
    // A step that throws (a platform error, or a defect) fails the removal.
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
      ...(archived === null ? {} : { details: { archive: archived } }),
    };
  } finally {
    if (snapshot !== null)
      rmSync(snapshot.dir, { recursive: true, force: true });
  }
}
/** What the receipt's reason says of an archive written before removal. */
function archiveNote(archived: Archived | null): string {
  return archived === null
    ? ""
    : ` archived ${archived.paths.length} ignored path(s), ${archived.bytes} bytes, to ${archived.path},`;
}
/**
 * The archive policy with the instant marking began on this host, read once
 * per run; undefined, so nothing is archived, without a policy or when the
 * instant cannot be read or recorded.
 */
function legacyPolicy(
  archive: ArchivePolicy | undefined,
): () => LegacyPolicy | undefined {
  let read: { value: LegacyPolicy | undefined } | undefined;
  return () => {
    if (read === undefined) {
      // Stamped even while archiving is off, so enabling it later does not
      // date the worktrees made meanwhile as older than marking.
      const since =
        archive === undefined ? undefined : markingSince(archive.root);
      read = {
        value:
          archive !== undefined && archive.maxBytes > 0 && since?.ok
            ? { ...archive, since: since.value }
            : undefined,
      };
    }
    return read.value;
  };
}
export function worktreesKind(
  repository: string,
  roots: string[],
  declaration: string,
  idleDays = 7,
  policy?: WorktreePolicy,
  orca?: string,
  archive?: ArchivePolicy,
): CollectionKind {
  const legacy = legacyPolicy(archive);
  return {
    name: "worktrees",
    repository,
    declaration,
    inventory: async () => {
      // The marking boundary is this run's, whether or not a worktree reaches proof.
      legacy();
      const output = await git(repository, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      if (!output.ok) return output;
      const entries: { id: string; details: Record<string, unknown> }[] = [];
      for (const block of output.value.split("\0\0").filter(Boolean)) {
        const fields = block.split("\0");
        const path = fields.find((field) => field.startsWith("worktree "));
        if (!path) return failed("malformed", "Malformed Git worktree record");
        entries.push({
          // Native separators: Git for Windows prints forward slashes.
          id: normalize(path.slice(9)),
          details: {
            locked: fields.some(
              (field) => field === "locked" || field.startsWith("locked "),
            ),
          },
        });
      }
      if (entries.length === 0)
        return failed(
          "malformed",
          "Git worktree inventory was empty or malformed",
        );
      const canonical = roots.map((root) => {
        try {
          // As git spells a worktree: links resolved and, on Windows, 8.3
          // short names expanded.
          return realpathSync.native(root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
          throw error;
        }
      });
      const selected = entries
        .slice(1)
        .filter((entry) => canonical.some((root) => within(entry.id, root)));
      if (orca === undefined || selected.length === 0) return ok(selected);
      const managed = await orcaWorktrees(orca, repository);
      if (!managed.ok) return managed;
      for (const entry of selected) {
        const row = managed.value.get(canonicalWorktree(entry.id));
        entry.details.runtime = row === undefined ? "none" : "orca";
        if (row !== undefined) {
          entry.details.orca = row.id;
          entry.details.orcaPath = row.path;
        }
      }
      return ok(selected);
    },
    prove: async (resource) => {
      if (isMapping(resource.details) && resource.details.locked === true)
        return { state: "live", reason: "worktree is locked" };
      const resolved =
        policy === undefined ? await worktreePolicy(repository) : ok(policy);
      if (!resolved.ok)
        return { state: "unverified", reason: resolved.failure.reason };
      const proving = { ...resolved.value, legacy: legacy() };
      const proved =
        orca !== undefined && orcaId(resource) !== null
          ? await runtimeWorktreeProof(resource.id, proving, idleDays, {
              orca,
            })
          : await worktreeProof(resource.id, proving, idleDays);
      return proved.ok
        ? proved.value
        : { state: "unverified", reason: proved.failure.reason };
    },
    collect: async (resource) => {
      const id = orcaId(resource);
      if (orca !== undefined && id !== null)
        return guardedCollection(resource, orcaPath(resource), (launched) =>
          collectThroughOrca(
            orca,
            resource,
            { id, launched },
            repository,
            declaration,
            legacy(),
          ),
        );
      return {
        outcome: "refused",
        reason: "uncoordinated worktrees are report-only",
      };
    },
    describe: (resource) => resource.id,
    exclusive: (body) => body(),
  };
}
