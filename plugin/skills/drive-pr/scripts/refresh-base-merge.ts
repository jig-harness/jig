/** Refresh a stopped converged drive after a clean merge of its base. */
import { isRecord } from "../../../shared/guards.ts";
import { readRemoteName } from "../../../shared/consumer.ts";
import { swallow } from "../../../shared/errors.ts";
import {
  announceReady,
  type AnnounceReady,
  driveRules,
} from "./lib/announce-ready.ts";
import {
  announcedIds,
  announcements,
  headMarker,
  postAnnouncement,
  readAnnouncement,
  withdrawAnnouncement,
} from "./lib/announce.ts";
import { APPROVAL_WARNING } from "./lib/announce-wording.ts";
import { basePreservesReview, witnessedReview } from "./lib/carried-review.ts";
import { isGitSha, runMain } from "./lib/cli.ts";
import {
  acquireObservedLock,
  prLockName,
  release,
  type DriveLock,
} from "./lib/driver/locks.ts";
import { exportPolicyBase } from "./lib/driver/policy-base.ts";
import { BASE_MERGE_CI_PENDING } from "./lib/ci-proof.ts";
import {
  ciHoldTimeoutSeconds,
  ghCall,
  git,
  gitIdentityEnv,
  run,
  tsArgv,
} from "./lib/proc.ts";
import {
  claimFloor,
  type Ledger,
  type LedgerSnapshot,
} from "./lib/state/ledger.ts";
import {
  readCompleteLedgerSnapshot,
  resolveLogin,
  writeLedger,
} from "./lib/state/ledger-forge.ts";
import { LEDGER_NOT_WRITTEN_EXIT } from "./lib/state/ledger-mirror.ts";
import { resolveStateDir } from "./lib/state/store.ts";
import { DRIVE_EXIT } from "./lib/status/terminal-states.ts";

const FALLBACK = 2;
const WAIT = 4;

function diagnostic(reason: string): void {
  console.error(`base-merge refresh: ${reason}`);
}

function unreadable(reason: string): number {
  diagnostic(reason);
  return FALLBACK;
}

async function withdraw(pr: string, id: number): Promise<boolean> {
  if (await withdrawAnnouncement(pr, id)) return true;
  diagnostic(`could not withdraw announcement comment ${id}`);
  return false;
}

async function liveBase(pr: string, head: string): Promise<string | null> {
  const result = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,baseRefOid,mergeable,isDraft",
  ]);
  if (result.code !== 0) {
    diagnostic(`the live pull request read exited ${result.code}`);
    return null;
  }
  try {
    const data: unknown = JSON.parse(result.stdout);
    return isRecord(data) &&
      data.state === "OPEN" &&
      data.headRefOid === head &&
      data.mergeable === "MERGEABLE" &&
      data.isDraft === false &&
      typeof data.baseRefOid === "string" &&
      isGitSha(data.baseRefOid)
      ? data.baseRefOid
      : null;
  } catch (error) {
    swallow(error, "the refresh could not parse the live pull request");
    return null;
  }
}

interface Request {
  pr: string;
  head: string;
  verified: string;
  generation: number;
  login: string;
}

interface Candidate extends Request {
  old: Ledger;
  base: string;
  reviewed: string;
  unchanged(snapshot: LedgerSnapshot): boolean;
}

async function readCandidate(request: Request): Promise<Candidate | number> {
  const { pr, head, verified, generation, login } = request;
  const previous = await readCompleteLedgerSnapshot(pr, login);
  if (typeof previous === "string")
    return unreadable("the stopped ledger did not read");
  const canonical = previous.canonical;
  if (canonical?.parsed.kind !== "ledger") return FALLBACK;
  const old = canonical.parsed.ledger;
  if (
    old.generation !== generation ||
    old.verifiedSha !== verified ||
    old.driver.state !== "stopped" ||
    old.driver.exit !== DRIVE_EXIT.CONVERGED ||
    old.driver.personStop !== undefined
  )
    return FALLBACK;
  if (previous.claims.some(({ claim }) => claim.generation >= generation))
    return FALLBACK;
  const base = await liveBase(pr, head);
  if (base === null) return FALLBACK;
  return {
    ...request,
    old,
    base,
    reviewed: old.reviewCarriedFrom ?? verified,
    unchanged: (snapshot) =>
      snapshot.canonical?.comment.id === canonical.comment.id &&
      snapshot.canonical.comment.body === canonical.comment.body &&
      snapshot.maxGeneration === previous.maxGeneration &&
      claimFloor(snapshot.claims) === claimFloor(previous.claims),
  };
}

async function checkHistory({
  pr,
  head,
  verified,
  reviewed,
  base,
}: Candidate): Promise<number> {
  const cwd = process.cwd();
  const gitRead = (args: string[], timeoutSec: number) =>
    git(args, { env: gitIdentityEnv(), timeoutSec });
  const available = await gitRead(
    ["rev-list", "--no-walk", verified, reviewed, head, base],
    5,
  );
  if (available.code !== 0) {
    const remote = readRemoteName(cwd);
    if ("error" in remote) return unreadable("the Git remote did not resolve");
    const fetched = await gitRead(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        remote.remote,
        `refs/pull/${pr}/head`,
        base,
      ],
      15,
    );
    if (fetched.code !== 0)
      return unreadable(`fetching the Git objects exited ${fetched.code}`);
  }
  if (!(await basePreservesReview(cwd, reviewed, head, base))) return FALLBACK;
  const policy = await exportPolicyBase(pr);
  if ("error" in policy) return unreadable("the live base policy did not read");
  if (policy.commit !== base) return FALLBACK;
  return (await witnessedReview(null, reviewed, driveRules())) ? 0 : FALLBACK;
}

async function checkCi({ pr, head, reviewed }: Candidate): Promise<number> {
  const checked = await run(
    tsArgv(`${import.meta.dir}/ci-hold.ts`, [
      "final-ready",
      pr,
      "--expect-head",
      head,
      "--require-success",
      "--base-merge-from",
      reviewed,
    ]),
    { timeoutSec: ciHoldTimeoutSeconds() },
  );
  if (checked.code === 0) return 0;
  if (checked.code === 4 && checked.stdout.trim() === BASE_MERGE_CI_PENDING)
    return WAIT;
  diagnostic(
    `the refreshed head's CI check exited ${checked.code}${checked.stderr.trim() === "" ? "" : `: ${checked.stderr.trim()}`}`,
  );
  return FALLBACK;
}

/** Resume a refresh that posted before updating the ledger. */
async function ensureAnnouncement(
  { pr, head, reviewed }: Candidate,
  standing: NonNullable<Awaited<ReturnType<typeof announcements>>>,
  ready: AnnounceReady,
): Promise<{ postedId?: number } | null> {
  if (announcedIds(standing, head).length !== 0) return {};
  const published = await postAnnouncement(
    pr,
    head,
    [
      `The pull request's change is the same as the change reviewed at \`${reviewed}\`.`,
      `A clean merge of its base moved the head to \`${head}\`, where the required checks passed.`,
      ready.lane === "approve-first"
        ? APPROVAL_WARNING
        : "A person decides when to merge.",
      headMarker(head),
    ].join("\n\n"),
  );
  if (!published.ok) {
    diagnostic(`the announcement write reported ${published.failure.code}`);
    return null;
  }
  const { id, posted } = published.value;
  const confirmed = await readAnnouncement(pr, posted);
  if (confirmed.ok && confirmed.value.verdict === "holds")
    return { postedId: id };
  const withdrawn = await withdraw(pr, id);
  return withdrawn && confirmed.ok && confirmed.value.verdict === "lost-to"
    ? {}
    : null;
}

async function current(
  candidate: Candidate,
  lane: AnnounceReady["lane"],
): Promise<boolean> {
  const { pr, head, reviewed, base } = candidate;
  const fresh = await announceReady(pr, head, reviewed);
  return (
    fresh.rc === 0 &&
    fresh.lane === lane &&
    (await checkCi(candidate)) === 0 &&
    (await liveBase(pr, head)) === base
  );
}

async function publishLedger(candidate: Candidate): Promise<number> {
  const { pr, head, reviewed, old, login, unchanged } = candidate;
  const written = await writeLedger(pr, login, (snapshot) =>
    unchanged(snapshot)
      ? {
          ...old,
          generation: snapshot.maxGeneration + 1,
          verifiedSha: head,
          reviewCarriedFrom: reviewed,
        }
      : "the stopped ledger or its claims changed",
  );
  if (written.kind === "written") return 0;
  // A lost PATCH response may still have advanced the ledger.
  const latest = await readCompleteLedgerSnapshot(pr, login);
  if (typeof latest === "string") return LEDGER_NOT_WRITTEN_EXIT;
  const parsed = latest.canonical?.parsed;
  return parsed?.kind === "ledger" &&
    parsed.ledger.driver.state === "stopped" &&
    parsed.ledger.driver.exit === DRIVE_EXIT.CONVERGED &&
    parsed.ledger.verifiedSha === head
    ? 0
    : FALLBACK;
}

async function refresh(request: Request): Promise<number> {
  const { pr, head, verified } = request;
  const candidate = await readCandidate(request);
  if (typeof candidate === "number") return candidate;
  const standing = await announcements(pr);
  if (
    standing === null ||
    standing.some((comment) => comment.unreadable !== undefined)
  )
    return FALLBACK;
  if (head === verified) {
    const stale = standing.filter((comment) => comment.head !== head);
    const withdrawn = await Promise.all(
      stale.map(({ id }) => withdraw(pr, id)),
    );
    return withdrawn.every(Boolean) ? 0 : FALLBACK;
  }
  const history = await checkHistory(candidate);
  if (history !== 0) return history;
  if (announcedIds(standing, verified).length === 0) return FALLBACK;

  const ci = await checkCi(candidate);
  if (ci !== 0) return ci;
  const ready = await announceReady(pr, head, candidate.reviewed);
  if (ready.rc !== 0 || (await liveBase(pr, head)) !== candidate.base)
    return FALLBACK;
  const announcement = await ensureAnnouncement(candidate, standing, ready);
  if (announcement === null) return FALLBACK;

  const result = (await current(candidate, ready.lane))
    ? await publishLedger(candidate)
    : FALLBACK;
  if (result === FALLBACK && announcement.postedId !== undefined)
    await withdraw(pr, announcement.postedId);
  if (result !== 0) return result;
  for (const stale of announcedIds(standing, verified))
    await withdraw(pr, stale);
  return 0;
}

runMain("refresh-base-merge.ts", async () => {
  const [pr = "", head = "", verified = "", rawGeneration = ""] =
    process.argv.slice(2);
  const generation = Number(rawGeneration);
  if (
    !/^[1-9]\d*$/.test(pr) ||
    !isGitSha(head) ||
    !isGitSha(verified) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return FALLBACK;
  const login = await resolveLogin();
  if (login === null) return FALLBACK;
  const lock: DriveLock = {
    stateDir: await resolveStateDir(),
    name: prLockName(pr),
    what: `PR #${pr} base merge refresh`,
  };
  if (!acquireObservedLock(lock, null)) return DRIVE_EXIT.SINGLE_INSTANCE_LOCK;
  try {
    return await refresh({ pr, head, verified, generation, login });
  } finally {
    release(lock);
  }
});
