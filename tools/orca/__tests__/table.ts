/**
 * The table of answers the Orca workspace tool's tests run against: Orca,
 * git and the host replaced by answers keyed on the whole command line, so
 * nothing reaches Orca, git or a host. Hooks run through the same table (the
 * remote runner), since the local one is the Herdr tool's supervisor, tested
 * with that tool.
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_JOURNAL_IN_GIT_DIR } from "../../../plugin/skills/reflect/scripts/lib/context.ts";
import {
  type Answer,
  fail,
  fakeContext,
  type FakeContext,
  ok,
} from "../../herdr/__tests__/fake.ts";
import type { RunResult } from "../../herdr/runner.ts";
import {
  CREATE_HOOK_CLAIM,
  CREATE_HOOK_MARK,
  HOST_ENVIRONMENT_SCRIPT,
  inspectCommand,
} from "../hooks.ts";
import { fileSegment, type Receipt, receiptPath } from "../receipts.ts";
import { remoteHook, type Workspace } from "../runner.ts";
import type { OpenOptions } from "../workspace.ts";

export const R = "/repo";
export const B = "feat/x";
export const WT = "/ws/repo/feat-x";
export const RID = "rid";
export const ID = `${RID}::${WT}`;
export const ORCA_BRANCH = "me/feat-x";
export const HOOK = `${WT}/.config/worktree-hooks/create`;
export const GIT_DIR = "/repo/.git/worktrees/feat-x";
export const MARK = `${GIT_DIR}/${CREATE_HOOK_MARK}`;
export const CLAIM = `${GIT_DIR}/${CREATE_HOOK_CLAIM}`;
export const JOURNAL = `${GIT_DIR}/${DEFAULT_JOURNAL_IN_GIT_DIR}`;
/** The worktree's own Jig configuration on the host. */
export const REPO_CONFIG = `${WT}/.config/jig.yaml`;
/** The host user's Jig configuration, under the home directory the host's shell reports. */
export const USER_CONFIG = "/home/me/.jig/jig.yaml";
/** The host's shell asked for its layer-selection variables and home directory. */
export const hostEnv = `sh -c ${HOST_ENVIRONMENT_SCRIPT}`;
type HostVariable = "HOME" | "JIG_HOME" | "JIG_OVERLAY" | "JIG_USER_LAYER";
/** The host's answer: each variable's value NUL-terminated, an unset one empty. */
export const hostEnvOf = (
  vars: Partial<Record<HostVariable, string>> = { HOME: "/home/me" },
): RunResult =>
  ok(
    (["HOME", "JIG_HOME", "JIG_OVERLAY", "JIG_USER_LAYER"] as HostVariable[])
      .map((name) => `${vars[name] ?? ""}\0`)
      .join(""),
  );
/** The host asked what is at a path. */
export const inspect = (path: string): string => inspectCommand(path).join(" ");
/** The host's listing of a regular file, a directory, and its message that nothing is there. */
export const isFile = ok("-rw-r--r--  1 me  staff  12 Jan  1 00:00 x\n");
export const isDir = ok("drwxr-xr-x  3 me  staff  96 Jan  1 00:00 x\n");
export const absent = fail(
  2,
  "ls: cannot access 'x': No such file or directory\n",
);

/** An Orca success envelope. */
export const answer = (result: unknown): RunResult =>
  ok(JSON.stringify({ id: "1", ok: true, result }));
/** An Orca error envelope, exit 1. */
export const orcaError = (code: string, message = code): RunResult => ({
  status: 1,
  stdout: JSON.stringify({ id: "1", ok: false, error: { code, message } }),
  stderr: "",
});

export const porcelain = (rows: [string, string][]): RunResult =>
  ok(
    rows
      .flatMap(([path, branch]) => [
        `worktree ${path}`,
        `branch refs/heads/${branch}`,
        "",
      ])
      .join("\0"),
  );

export const row = (branch: string, path = WT, id = ID) => ({
  id,
  path,
  branch: `refs/heads/${branch}`,
});

export const options: OpenOptions = {
  repo: "app",
  branch: B,
  base: "origin/main",
  agent: "claude",
  noAgent: false,
  prompt: "/jig:do-item ENG-1",
  key: "ENG-1",
  comment: "ENG-1: Fix",
  linearIssue: "ENG-1",
  activate: true,
};

export const show = "orca repo show --repo name:app --json";
export const list = `orca worktree list --repo id:${RID} --json`;
export const gitList = `git -C ${R} worktree list --porcelain -z`;
export const lsRemote = `git -C ${R} ls-remote --exit-code --heads origin ${B}`;
export const fetchBranch = `git -C ${R} fetch --prune origin +refs/heads/${B}:refs/remotes/origin/${B}`;
export const dropRef = `git -C ${R} update-ref -d refs/remotes/origin/${B}`;
export const remoteRef = `git -C ${R} rev-parse --verify --quiet refs/remotes/origin/${B}`;
export const localRef = `git -C ${R} show-ref --verify --quiet refs/heads/${B}`;
export const fetchBase = `git -C ${R} fetch --prune origin +refs/heads/main:refs/remotes/origin/main`;
export const create = (from: string) =>
  `orca worktree create --repo id:${RID} --name ${B} --base-branch ${from} --no-parent --setup skip --comment ENG-1: Fix --activate --json`;
export const link = `orca worktree set --worktree id:${ID} --linear-issue ENG-1 --json`;
export const launch = `orca agent launch --agent claude --worktree id:${ID} --prompt /jig:do-item ENG-1 --json`;
export const testHook = `test -x ${HOOK}`;
export const gitDir = `git -C ${WT} rev-parse --absolute-git-dir`;
export const commonDir = (path: string) =>
  `git -C ${path} rev-parse --path-format=absolute --git-common-dir`;
export const rename = `git -C ${WT} branch -m ${ORCA_BRANCH} ${B}`;
export const markWrite = `sh -c printf ok > ${MARK}`;
export const takeClaim = `mkdir ${CLAIM}`;
export const releaseClaim = `rm -rf ${CLAIM}`;

/**
 * What every run asks: the name check, the repository, the checks of the
 * worktree and its clone, the upstream check (origin lacks the branch).
 */
export const common: Record<string, Answer> = {
  [`git check-ref-format --branch ${B}`]: ok(B),
  [show]: answer({ repo: { id: RID, path: R } }),
  [gitDir]: ok(`${GIT_DIR}\n`),
  [commonDir(WT)]: ok("/repo/.git\n"),
  [commonDir(R)]: ok("/repo/.git\n"),
  [testHook]: fail(1),
  [link]: orcaError("linear_not_connected"),
  [fetchBranch]: fail(128, "couldn't find remote ref"),
  [dropRef]: ok(),
  [remoteRef]: fail(1),
};

/** A branch neither side has, created from the base. */
export const fresh: Record<string, Answer> = {
  ...common,
  [gitList]: [
    porcelain([[R, "main"]]),
    porcelain([
      [R, "main"],
      [WT, B],
    ]),
  ],
  [lsRemote]: fail(2),
  [localRef]: fail(1),
  [fetchBase]: ok(),
  [create("origin/main")]: answer({
    worktree: row(ORCA_BRANCH),
  }),
  [`git -C ${WT} symbolic-ref --short HEAD`]: ok(`${ORCA_BRANCH}\n`),
  [rename]: ok(),
  [launch]: answer({ launch: { outcome: { kind: "terminal" } } }),
};

/** A branch a checkout already holds. */
export const held: Record<string, Answer> = {
  ...common,
  [gitList]: porcelain([
    [R, "main"],
    [WT, B],
  ]),
  [list]: answer({ worktrees: [row(B)] }),
  [launch]: answer({}),
};

export function workspaceOf(
  table: Record<string, Answer>,
  environment?: string,
  ssh?: string,
  stateDir = mkdtempSync(join(tmpdir(), "orca-state-")),
): Workspace & { ctx: FakeContext } {
  const ctx = fakeContext(table, stateDir);
  return {
    ctx,
    orca: ctx,
    host: ctx,
    runHook: remoteHook,
    target: {
      command: "orca",
      ...(environment === undefined ? {} : { environment }),
    },
    ...(ssh === undefined ? {} : { ssh }),
  };
}

/** The table with every Orca call addressed to the server `box`. */
export function onBox(table: Record<string, Answer>): Record<string, Answer> {
  const served: Record<string, Answer> = {};
  for (const [key, value] of Object.entries(table))
    served[
      key.startsWith("orca ") && !key.includes("--environment")
        ? key.replace(/ --json$/, " --environment box --json")
        : key
    ] = value;
  return served;
}

export const receiptOf = (ws: Workspace, key = "ENG-1", agent = "claude") =>
  receiptPath(ws, RID, key, agent);

export function writeReceiptFile(file: string, receipt: object): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(receipt));
}

export const sentReceipt = (worktreeId = ID): Receipt => ({
  key: "ENG-1",
  status: "sent",
  repoId: RID,
  worktreeId,
  agent: "claude",
  environment: null,
  at: "2026-01-01T00:00:00Z",
});

/** Where an open sets a stale receipt aside: beside it, under the start it records. */
export const retiredAs = (file: string, receipt: Receipt): string =>
  `${file}.retired-${fileSegment(receipt.at)}`;

/** The files set aside beside a receipt. */
export const retiredBeside = (file: string): string[] =>
  readdirSync(dirname(file)).filter((name) =>
    name.startsWith(`${file.slice(dirname(file).length + 1)}.retired-`),
  );
