import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { errnoCode, swallow } from "../../../../shared/errors.ts";
import { currentMs } from "../../../../shared/time.ts";
import { gitIdentityEnv, run, type RunResult } from "./proc.ts";

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_MERGES = 8;
const GIT_TIMEOUT_SEC = 5;

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    swallow(error, "the base merge proof could not read Git attributes");
    return false;
  }
}

type GitRead = (args: string[]) => Promise<RunResult>;

function gitForProof(cwd: string): GitRead {
  const deadline = currentMs() + GIT_TIMEOUT_SEC * 2000;
  return (args) =>
    run(["git", "--no-replace-objects", ...args], {
      cwd,
      env: {
        ...gitIdentityEnv(),
        GIT_ATTR_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_GRAFT_FILE: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
      },
      timeoutSec: Math.max(
        0.001,
        Math.min(GIT_TIMEOUT_SEC, (deadline - currentMs()) / 1000),
      ),
    });
}

function supportsReplay(version: RunResult): boolean {
  // Older Git can crash while merge-tree reads --attr-source.
  const match = /^git version (\d+)\.(\d+)/.exec(version.stdout);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  return version.code === 0 && (major > 2 || (major === 2 && minor >= 43));
}

async function historyForReplay(
  git: GitRead,
  cwd: string,
  verified: string,
  head: string,
  base: string,
): Promise<{ rows: string[]; emptyTree: string } | null> {
  const [version, commits, drivers, attributes, empty, absorbed] =
    await Promise.all([
      git(["--version"]),
      git([
        "log",
        "--first-parent",
        "--no-show-signature",
        "--format=%H %T %P",
        `--max-count=${MAX_MERGES + 1}`,
        `${verified}..${head}`,
        "--",
      ]),
      git(["config", "--get-regexp", "^merge\\..*\\.driver$"]),
      git(["rev-parse", "--git-path", "info/attributes"]),
      git(["hash-object", "-t", "tree", "/dev/null"]),
      git(["merge-base", "--is-ancestor", verified, base]),
    ]);
  const emptyTree = empty.stdout.trim();
  const infoAttributes = attributes.stdout.trimEnd();
  if (
    !supportsReplay(version) ||
    commits.code !== 0 ||
    drivers.code !== 1 ||
    attributes.code !== 0 ||
    infoAttributes === "" ||
    empty.code !== 0 ||
    !OID.test(emptyTree) ||
    absorbed.code !== 1 ||
    !(await absent(resolve(cwd, infoAttributes)))
  )
    return null;

  return { rows: commits.stdout.trim().split("\n"), emptyTree };
}

async function replaysCleanly(
  git: GitRead,
  {
    rows,
    emptyTree,
  }: NonNullable<Awaited<ReturnType<typeof historyForReplay>>>,
  verified: string,
  head: string,
  base: string,
): Promise<boolean> {
  if (rows.length > MAX_MERGES) return false;
  let tip = head;
  for (const row of rows) {
    const fields = row.split(" ");
    if (fields.length !== 4 || !fields.every((oid) => OID.test(oid)))
      return false;
    const [commit, tree, prior, mergedBase] = fields as [
      string,
      string,
      string,
      string,
    ];
    if (commit !== tip) return false;
    const ancestor = await git([
      "merge-base",
      "--is-ancestor",
      mergedBase,
      base,
    ]);
    if (ancestor.code !== 0) return false;
    const replayed = await git([
      "--attr-source",
      emptyTree,
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "merge.default=text",
      "-c",
      "merge.renames=true",
      "-c",
      "merge.directoryRenames=conflict",
      "-c",
      "merge.renormalize=false",
      "merge-tree",
      "--write-tree",
      prior,
      mergedBase,
    ]);
    if (replayed.code !== 0 || replayed.stdout.trim() !== tree) return false;
    tip = prior;
  }
  return tip === verified;
}

async function contribution(
  git: GitRead,
  commit: string,
  base: string,
): Promise<string | null> {
  const ancestor = await git(["merge-base", "--all", commit, base]);
  const fork = ancestor.stdout.trim();
  if (ancestor.code !== 0 || !OID.test(fork)) return null;
  const diff = await git([
    "-c",
    "core.quotePath=true",
    "diff",
    "--raw",
    "--no-renames",
    "--no-abbrev",
    "--no-ext-diff",
    "--ignore-submodules=none",
    fork,
    commit,
    "--",
  ]);
  return diff.code === 0 ? diff.stdout : null;
}

/**
 * Prove that every commit after the verified head is a clean merge of an
 * ancestor of the live base into the PR's first-parent history. Compare the
 * recorded trees with fresh merges to detect a manual edit or resolution.
 * Missing objects, custom merge drivers and unreadable results leave the
 * proof undecided.
 */
export async function proveBaseMerge(
  cwd: string,
  verified: string,
  head: string,
  base: string,
): Promise<boolean> {
  if (
    head === verified ||
    ![verified, head, base].every((oid) => OID.test(oid))
  )
    return false;
  const git = gitForProof(cwd);
  const history = await historyForReplay(git, cwd, verified, head, base);
  if (
    history === null ||
    !(await replaysCleanly(git, history, verified, head, base))
  )
    return false;
  const [before, after] = await Promise.all([
    contribution(git, verified, base),
    contribution(git, head, base),
  ]);
  return before !== null && before === after;
}
