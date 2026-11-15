/** Existing re-arm trees: drive ownership first, then unambiguous local evidence. */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseAddress } from "../../shared/address.ts";
import { remoteName } from "../../shared/consumer.ts";
import { swallow } from "../../shared/errors.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { gitIdentityEnv, run } from "../../shared/proc.ts";
import { parseGitWorktreeList } from "../../shared/orca-workspace/git.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import { peekCloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import type { DriveReading } from "../../ask/lib/drive.ts";
import { launchesWhere, machineFile } from "../../ask/lib/local.ts";
import { repoFromRemote } from "../../skills/do-item/scripts/lib/tracker/github/refs.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import type { ReadRecord } from "../../dispatch/lib/launches.ts";

/** A live directory, with aliases collapsed; missing paths are not candidates. */
interface InspectionFault {
  reason: string;
  cause: unknown;
}

function directory(
  path: string | null | undefined,
  faults: InspectionFault[],
): string | null {
  if (!path) return null;
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : null;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      swallow(error, "a removed worktree is not a rearm candidate");
    else
      faults.push({
        reason: `${path} could not be inspected: ${String(error)}`,
        cause: error,
      });
    return null;
  }
}

/** A successful pickup's explicit drive handoff names this pull request. */
function pickupFor(r: ReadRecord, ctx: AskContext): boolean {
  if (
    r.record.action !== "pickup" ||
    r.record.repo !== ctx.address.repo ||
    r.result !== "done" ||
    r.next == null ||
    !("address" in r.next)
  )
    return false;
  const next = parseAddress(r.next.address);
  return (
    next.ok &&
    next.value.station === "drive" &&
    next.value.repo === ctx.address.repo &&
    next.value.key === ctx.address.key
  );
}

const LOOKED =
  "drive listing, drive launch records, pickup result records and git worktree lists of the repository's known clones";

/** An incomplete read never proves a unique candidate. */
function unreadable(
  reason: string,
  cause?: unknown,
): Outcome<never, "refused"> {
  return failed(
    "refused",
    `cannot find a unique existing worktree after reading ${LOOKED}: ${reason}`,
    cause,
  );
}

function inspectionFailure(
  faults: InspectionFault[],
): Outcome<never, "refused"> {
  return unreadable(
    faults.map((f) => f.reason).join("; "),
    new AggregateError(
      faults.map((f) => f.cause),
      "worktree inspection failed",
    ),
  );
}

/** Existing ownership records keep precedence over the fallback search. */
async function ownedTree(
  ctx: AskContext,
  d: DriveReading,
): Promise<Outcome<string | null, "refused">> {
  const faults: InspectionFault[] = [];
  const launches = [...d.records].sort((a, b) =>
    b.record.createdAt.localeCompare(a.record.createdAt),
  );
  const paths = [
    d.row?.worktree,
    ...launches.map((r) => r.record.workspace?.path),
  ];
  for (const path of paths) {
    const found = directory(path, faults);
    if (faults.length > 0) return inspectionFailure(faults);
    if (found === null) continue;
    const matches = await matchesStoppedDriver(ctx, d, found);
    if (!matches.ok) return matches;
    if (matches.value) return ok(found);
  }
  return ok(null);
}

interface Search {
  clones: Set<string>;
  candidates: Set<string>;
  faults: InspectionFault[];
}

/** A clone's identity, read without inherited Git redirection and within this answer's deadline. */
async function cloneRepo(
  ctx: AskContext,
  clone: string,
): Promise<Outcome<string, "refused">> {
  const sec = ctx.reading.sourceSec();
  if (sec === 0)
    return unreadable(
      "the answer's deadline passed before reading repository identity",
    );
  const remote = remoteName(clone);
  const read = await run(
    ["git", "-C", clone, "config", "--get", `remote.${remote}.url`],
    { timeoutSec: sec, stderr: "pipe", env: gitIdentityEnv() },
  );
  const repo = read.code === 0 ? repoFromRemote(read.stdout.trim()) : null;
  if (repo === null)
    return unreadable(
      `repository identity could not be read for configured clone ${clone}: git exited ${read.code}${read.timedOut ? " at its deadline" : ""}; ${read.stderr.trim()}`,
    );
  return ok(`${repo.owner}/${repo.name}`);
}

/** The machine's configured clones and the checkout this command runs in. */
async function searchFor(ctx: AskContext): Promise<Outcome<Search, "refused">> {
  const machine = machineFile();
  if (!machine.ok)
    return unreadable(machine.failure.reason, machine.failure.cause);
  const paths = new Set((machine.value?.repositories ?? []).map((r) => r.path));
  if (ctx.checkout !== null) paths.add(ctx.checkout);
  const clones = new Set<string>();
  for (const path of paths) {
    const repo = await cloneRepo(ctx, path);
    if (!repo.ok) return repo;
    if (repo.value === ctx.address.repo) clones.add(path);
  }
  return ok({ clones, candidates: new Set(), faults: [] });
}

/** Successful pickup handoffs add their workspace and clone to the search. */
async function pickupTrees(
  ctx: AskContext,
  search: Search,
): Promise<Outcome<void, "refused">> {
  if (ctx.dispatcher === null) return ok(undefined);
  const records = await launchesWhere(ctx.dispatcher, (r) => pickupFor(r, ctx));
  if (!records.ok)
    return unreadable(records.failure.reason, records.failure.cause);
  if (records.value.unreadable.length > 0)
    return unreadable(records.value.unreadable.join("; "));
  for (const r of records.value.records) {
    search.clones.add(r.record.repoPath);
    addCandidate(search, r.record.workspace?.path);
  }
  return ok(undefined);
}

function addCandidate(search: Search, path: string | undefined): void {
  const found = directory(path, search.faults);
  if (found !== null) search.candidates.add(found);
}

/** A current ledger's stopped-driver identity must match a tree sent to the dispatcher. */
async function matchesStoppedDriver(
  ctx: AskContext,
  d: DriveReading,
  path: string,
): Promise<Outcome<boolean, "refused">> {
  const driver =
    typeof d.ledger === "object" && d.ledger !== null ? d.ledger.driver : null;
  // Ledgers written before clone identities included their host suffix remain
  // readable, but cannot prove the stronger current ownership relation.
  if (driver === null || !driver.clone.includes("@")) return ok(true);
  let actor: string;
  try {
    actor = `wt-${worktreePathKey(path)}`;
  } catch (error) {
    return unreadable(
      `the worktree identity of candidate ${path} could not be read: ${String(error)}`,
      error,
    );
  }
  if (actor !== driver.actor) return ok(false);
  const sec = ctx.reading.sourceSec();
  if (sec === 0)
    return unreadable(
      "the answer's deadline passed before reading worktree identity",
    );
  const common = await run(
    ["git", "-C", path, "rev-parse", "--git-common-dir"],
    {
      timeoutSec: sec,
      stderr: "pipe",
      env: gitIdentityEnv(),
    },
  );
  if (common.code !== 0)
    return unreadable(
      `the clone identity of candidate ${path} could not be read: git exited ${common.code}${common.timedOut ? " at its deadline" : ""}; ${common.stderr.trim()}`,
    );
  let key: string | null;
  try {
    key = peekCloneKey(resolve(path, common.stdout.trim()));
  } catch (error) {
    return unreadable(
      `the clone identity file of candidate ${path} could not be read: ${String(error)}`,
      error,
    );
  }
  if (key === null || cloneId(key) !== driver.clone) return ok(false);
  return ok(true);
}

/** Keep only trees the dispatcher can prove are the stopped driver's own. */
async function driverTrees(
  ctx: AskContext,
  d: DriveReading,
  search: Search,
): Promise<Outcome<void, "refused">> {
  const candidates = new Set<string>();
  for (const path of search.candidates) {
    const matches = await matchesStoppedDriver(ctx, d, path);
    if (!matches.ok) return matches;
    if (matches.value) candidates.add(path);
  }
  search.candidates = candidates;
  return ok(undefined);
}

/** One clone's complete git listing, bounded by the answer's remaining time. */
async function branchTrees(
  ctx: AskContext,
  search: Search,
  clone: string,
  branch: string,
): Promise<Outcome<void, "refused">> {
  const sec = ctx.reading.sourceSec();
  if (sec === 0) return unreadable("the answer's deadline passed");
  const listed = await run(
    ["git", "-C", clone, "worktree", "list", "--porcelain", "-z"],
    { timeoutSec: sec, stderr: "pipe", env: gitIdentityEnv() },
  );
  if (listed.code !== 0)
    return unreadable(
      `git worktree list in ${clone} exited ${listed.code}${listed.timedOut ? " at its deadline" : ""}: ${listed.stderr.trim()}`,
    );
  for (const row of parseGitWorktreeList(listed.stdout)) {
    if (branch && row.branch === branch) addCandidate(search, row.path);
  }
  return ok(undefined);
}

/** Selection follows only after every fallback source was read. */
function uniqueTree(
  search: Search,
  pr: string,
  branch: string | undefined,
): Outcome<string, "refused"> {
  if (search.faults.length > 0) return inspectionFailure(search.faults);
  const paths = [...search.candidates].sort();
  const [only] = paths;
  if (paths.length === 1 && only !== undefined) return ok(only);
  const detail =
    paths.length > 1
      ? `several existing worktrees of pull request ${pr} were found: ${paths.join(", ")}`
      : `no existing worktree of pull request ${pr} is known on this machine`;
  return failed(
    "refused",
    `${detail}; looked in ${LOOKED}${branch ? ` for branch ${branch}` : " (the forge names no head branch)"}: rearm never opens a replacement tree`,
  );
}

/** Never opens a tree, and refuses incomplete fallback reads rather than guessing uniqueness. */
export async function rearmTree(
  d: DriveReading,
  ctx: AskContext,
): Promise<Outcome<string, "refused">> {
  const owned = await ownedTree(ctx, d);
  if (!owned.ok) return owned;
  if (owned.value !== null) return ok(owned.value);
  const search = await searchFor(ctx);
  if (!search.ok) return search;
  const pickups = await pickupTrees(ctx, search.value);
  if (!pickups.ok) return pickups;
  const branch = d.pull?.doc.headRef;
  if (typeof branch !== "string" || branch === "")
    return unreadable("the forge did not provide the pull request head branch");
  for (const clone of search.value.clones) {
    const listed = await branchTrees(ctx, search.value, clone, branch);
    if (!listed.ok) return listed;
  }
  const matched = await driverTrees(ctx, d, search.value);
  if (!matched.ok) return matched;
  return uniqueTree(search.value, ctx.address.key, branch);
}
