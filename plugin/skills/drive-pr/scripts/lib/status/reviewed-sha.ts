/**
 * The reviewed-SHA gate: the reviewer's own stamp of the commit it reviewed
 * (the `ai-reviewed-sha` marker in its sticky comment), judged against the
 * pull request's head. `evaluate.ts` runs it where the reviewer gates apply
 * and turns what it returns into a state.
 *
 * A stamp naming an older commit is the stale-review signature (checks read
 * settled, the review was of the previous push), reported as `STALE_REVIEW`
 * and waited on. One exception: the reviewer's skip notice
 * (`skip-notice.ts`) names the current head as a push it did not review. It
 * will not review that head, so waiting is pointless:
 *
 * - when the pull request's own diff at the head equals its diff at the
 *   stamped commit (a base merge that left the change as it was), the review
 *   of the stamped commit covers the head. It stays the reviewed SHA, its
 *   source is `skip-notice`, and the drive converges on it;
 * - when the diffs differ, the drive stops as `REVIEW_SKIPPED`, naming the
 *   skip, for a person;
 * - when a commit the comparison needs is not in this clone, it is fetched
 *   once; still missing, the evaluation is `INDETERMINATE` and runs again.
 *
 * The pull request's diff at a head is the diff from the head's merge base
 * with the base branch to the head, as the forge shows it. The two are
 * compared with their context lines and every file as text (binary files and
 * files a `.gitattributes` diff driver would hide included), leaving out only
 * the hunks' line numbers and the blob ids, so a base that moved the change
 * down a file does not make it look different, and a merge that moved or
 * edited the change's lines does. Any doubt leaves the head unreviewed.
 */
import {
  consumerRoot,
  readRemoteName,
} from "../../../../../shared/consumer.ts";
import { fetchTimeoutSeconds } from "../base-drift.ts";
import { reviewerLabel } from "../overlay.ts";
import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  type RunResult,
} from "../proc.ts";
import type { StatusReport } from "./evaluate.ts";
import type { SkipNotice } from "./skip-notice.ts";

/**
 * Resolve a reviewer SHA marker to the full object id it names, or `''`.
 *
 * The marker grammar admits 7–40 hex, and "does this marker name the head?"
 * has one correct answer: a full marker is compared as-is, an abbreviated one
 * only after git resolves it to a single full commit — never a prefix
 * comparison, which accepts any commit sharing the head's first N characters
 * (7 hex is 28 bits: a birthday-bound coincidence, not an impossibility). The
 * stranded-check-run bypass and the reviewed-SHA gate both ask, so both call
 * this one helper.
 *
 * `--verify` refuses an ambiguous prefix and `^{commit}` refuses a non-commit,
 * so a non-empty return is always a unique commit in this clone. `''` covers
 * both "no marker" and "an abbreviation this clone cannot resolve" (a shallow
 * clone, an object never fetched, no git at all) — the two are the same thing
 * to every caller, which must treat `''` as fail-closed rather than as a
 * licence to fall back to a prefix comparison.
 */
export async function resolveMarkerSha(marker: string): Promise<string> {
  if (marker === "") return "";
  if (marker.length === 40) return marker;
  const rp = await localGit([
    "rev-parse",
    "--verify",
    "--quiet",
    `${marker}^{commit}`,
  ]);
  return rp.code === 0 ? rp.stdout.trim() : "";
}

/**
 * `git` in the driven tree (`DRIVE_PR_WORKTREE`, else the working directory),
 * with an inherited `GIT_DIR`/`GIT_WORK_TREE` scrubbed, as `drive-status.ts`'s
 * other local reads run, so the answer is about the tree being driven.
 */
function localGit(
  args: string[],
  timeoutSec: number = gitCallTimeoutSeconds(),
): Promise<RunResult> {
  const anchor = process.env.DRIVE_PR_WORKTREE;
  return git(args, {
    env: gitIdentityEnv(),
    timeoutSec,
    ...(anchor ? { cwd: anchor } : {}),
  });
}

/** What stops the evaluation at this gate; `null` lets it go on. */
export interface ReviewedShaStop {
  state: "STALE_REVIEW" | "REVIEW_SKIPPED" | "INDETERMINATE";
  reason: string;
}

/**
 * Judge the stamp (`marker`, resolved to `markerFull`) against
 * `report.apiHead`, setting `reviewedSha` and `reviewedShaSource`.
 *
 * No stamp falls back to the check-run, which was queried BY SHA and
 * therefore always matches: weaker evidence, labelled as such, enough to work
 * a round on and not to converge on (`lacksReviewerStamp` in `evaluate.ts`).
 * A stamp is compared for equality: a full one as written, an abbreviated one
 * only once resolved. One that cannot be resolved here is not a witness to
 * anything, so the gate fails closed: an unverifiable stamp costs a round, an
 * accepted wrong one costs the whole guard.
 */
export async function reviewedShaGate(
  report: StatusReport,
  marker: string,
  markerFull: string,
  skip: SkipNotice | null,
): Promise<ReviewedShaStop | null> {
  if (marker === "") {
    report.reviewedSha = report.apiHead;
    report.reviewedShaSource = "check-run";
    return null;
  }
  report.reviewedSha = marker;
  report.reviewedShaSource = "comment-marker";
  if (marker.length !== 40) {
    if (markerFull === "") {
      return {
        state: "STALE_REVIEW",
        reason: `${reviewerLabel()} recorded reviewing the abbreviated ${marker}, which cannot be resolved to a full commit id here — refusing to accept a prefix of the PR head (${report.apiHead}) as proof it reviewed this commit`,
      };
    }
    report.reviewedSha = markerFull;
  }
  if (markerFull === report.apiHead) return null;
  const named = marker === markerFull ? marker : `${marker} (${markerFull})`;
  const stale: ReviewedShaStop = {
    state: "STALE_REVIEW",
    reason: `${reviewerLabel()} last recorded reviewing ${named}, but the PR head is ${report.apiHead}`,
  };
  if (skip === null || (await resolveMarkerSha(skip.head)) !== report.apiHead)
    return stale;
  const notice = `its skip notice for this head reads "${skip.text}"`;
  const commits = [report.baseHead, markerFull, report.apiHead];
  let same = await sameChange(report.baseHead, markerFull, report.apiHead);
  if (typeof same !== "boolean") {
    const fetched = await fetchMissing(commits);
    if (fetched !== null) same = { failed: `${same.failed}; ${fetched}` };
    else same = await sameChange(report.baseHead, markerFull, report.apiHead);
  }
  if (typeof same !== "boolean") {
    return {
      state: "INDETERMINATE",
      reason: `${reviewerLabel()} skipped the PR head ${report.apiHead} and last recorded reviewing ${named}, but the pull request's diff at the two cannot be compared in this clone against the base ${report.baseHead} (git: ${same.failed}) — re-run once the commits can be read`,
    };
  }
  if (same) {
    report.reviewedShaSource = "skip-notice";
    return null;
  }
  return {
    state: "REVIEW_SKIPPED",
    reason: `${reviewerLabel()} skipped the PR head ${report.apiHead} and last recorded reviewing ${named}; ${notice}, and the pull request's diff at ${report.apiHead} differs from its diff at ${markerFull}, so no review of this head will come and the drive cannot converge on it. Fix: review the change since ${markerFull} yourself and have ${reviewerLabel()} review this head, or push a commit it reviews; then re-arm`,
  };
}

/**
 * Fetch whichever of `commits` this clone does not hold from the drive's
 * remote (`repository.remote`), under the fetch deadline. A commit id names
 * its content, so whichever remote serves it serves the right one. `null`
 * when it ran; else why it could not.
 */
async function fetchMissing(commits: string[]): Promise<string | null> {
  const missing: string[] = [];
  for (const commit of new Set(commits)) {
    const held = await localGit(["cat-file", "-e", `${commit}^{commit}`]);
    if (held.code !== 0) missing.push(commit);
  }
  if (missing.length === 0) return "every commit is in this clone";
  const top = await localGit(["rev-parse", "--show-toplevel"]);
  const remote = readRemoteName(consumerRoot(top.stdout.trim() || undefined));
  if ("error" in remote) return `no remote to fetch from: ${remote.error}`;
  const deadline = fetchTimeoutSeconds();
  const fetch = await localGit(
    ["fetch", "--quiet", "--no-tags", remote.remote, ...missing],
    deadline.ok ? deadline.seconds : 120,
  );
  return fetch.code === 0
    ? null
    : gitFailure(
        `fetch ${remote.remote} ${missing.join(" ")}`,
        fetch.stderrTail,
      ).failed;
}

/**
 * The note a verdict reached through a skip notice carries: which head the
 * reviewer reviewed and why that review stands for the current one.
 */
export function skipNote(report: StatusReport): string {
  return report.reviewedShaSource === "skip-notice"
    ? ` — ${reviewerLabel()} last reviewed ${report.reviewedSha} and skipped ${report.apiHead} (its skip notice names this head); the pull request's diff is the same at both, so that review stands for this head`
    : "";
}

/**
 * What the merge-ready announcement says the reviewer did, for the
 * `reviewedShaSource` and `reviewedSha` of a converged report.
 */
export function reviewedClaim(source: string, reviewedSha: string): string {
  return source === "skip-notice"
    ? `reviewed \`${reviewedSha.slice(0, 12)}\` and skipped this head, whose pull-request diff is the same`
    : "completed its review of this exact head";
}

/** Why git could not produce a diff here: a commit not in this clone, say. */
interface GitFailure {
  failed: string;
}

function gitFailure(what: string, tail: string): GitFailure {
  const said = tail.trim().replace(/\s+/g, " ");
  return { failed: said === "" ? `${what} failed` : `${what}: ${said}` };
}

/**
 * Whether the pull request's diff at `reviewed` is the same as at `head`,
 * measured against `base`, or why git cannot answer here.
 *
 * Both patches run from their own merge base. Where the two merge bases are
 * the same commit the patches are compared exactly. Where the base moved, the
 * files it changed between the two merge bases are compared without their
 * index lines and hunk positions, which that move shifts; every other file is
 * still compared exactly. A moved file whose patch cannot be compared that
 * way without loss is reported as different: git's output is decoded as UTF-8
 * (a byte that is not valid becomes U+FFFD, so two binary rewrites can read
 * alike), and a hunk whose old side occurs more than once in the file names no
 * single place once positions are dropped.
 */
async function sameChange(
  base: string,
  reviewed: string,
  head: string,
): Promise<boolean | GitFailure> {
  const [was, now] = await Promise.all([
    changeAt(base, reviewed),
    changeAt(base, head),
  ]);
  if ("failed" in was) return was;
  if ("failed" in now) return now;
  if (was.from === now.from) return was.patch === now.patch;
  const moved = await localGit([
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-relative",
    was.from,
    now.from,
    "--",
  ]);
  if (moved.code !== 0)
    return gitFailure(`diff ${was.from} ${now.from}`, moved.stderrTail);
  const shifted = new Set(moved.stdout.split("\0").filter((p) => p !== ""));
  const [a, b] = await Promise.all([
    normalizedSections(was, shifted),
    normalizedSections(now, shifted),
  ]);
  return a.join("\n") === b.join("\n");
}

/** A hunk header's line numbers, which a base that moved the change shifts. */
const HUNK_POSITION = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

interface Change {
  from: string;
  patch: string;
}

/**
 * The patch split per file, each file in `shifted` reduced to what a moved base
 * leaves alone. A file that cannot be reduced without loss gets a section no
 * other patch can equal, so the comparison fails closed.
 */
async function normalizedSections(
  change: Change,
  shifted: Set<string>,
): Promise<string[]> {
  const sections = change.patch.split(/^(?=diff --git )/m);
  const out: string[] = [];
  for (const [n, section] of sections.entries()) {
    const path = [...shifted].find((p) =>
      section.startsWith(`diff --git a/${p} b/${p}\n`),
    );
    if (path === undefined) out.push(section);
    else if (await losesInformation(change.from, path, section))
      out.push(`<<not comparable: ${change.from} ${n} ${path}>>`);
    else out.push(withoutPositions(section));
  }
  return out;
}

/** A file's patch without the index lines and hunk positions a moved base shifts. */
function withoutPositions(section: string): string {
  return section
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.replace(HUNK_POSITION, "@@ @@"))
    .join("\n");
}

/**
 * Whether dropping `section`'s positions would lose which place it changed:
 * its text is not valid UTF-8, or a hunk's old side occurs more than once in
 * the file at `from`.
 */
async function losesInformation(
  from: string,
  path: string,
  section: string,
): Promise<boolean> {
  if (section.includes("\uFFFD")) return true;
  const old = await localGit(["show", `${from}:${path}`]);
  if (old.code !== 0) return false;
  return oldSides(section).some((block) => {
    const first = old.stdout.indexOf(block);
    return first !== -1 && old.stdout.indexOf(block, first + 1) !== -1;
  });
}

/** Each hunk's old-side text (context and removed lines) of one file's patch. */
function oldSides(section: string): string[] {
  const blocks: string[][] = [];
  for (const line of section.split("\n")) {
    if (HUNK_POSITION.test(line)) blocks.push([]);
    else if (line.startsWith(" ") || line.startsWith("-"))
      blocks.at(-1)?.push(line.slice(1));
  }
  return blocks.filter((b) => b.length > 0).map((b) => b.join("\n"));
}

async function changeAt(
  base: string,
  head: string,
): Promise<Change | GitFailure> {
  const mergeBase = await localGit(["merge-base", base, head]);
  const from = mergeBase.stdout.trim();
  if (mergeBase.code !== 0 || from === "")
    return gitFailure(`merge-base ${base} ${head}`, mergeBase.stderrTail);
  const diff = await localGit([
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--no-renames",
    "--no-relative",
    "--ignore-submodules=none",
    "--unified=3",
    from,
    head,
    "--",
  ]);
  if (diff.code !== 0)
    return gitFailure(`diff ${from} ${head}`, diff.stderrTail);
  return { from, patch: diff.stdout };
}
