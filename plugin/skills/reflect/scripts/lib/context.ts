/**
 * What a reflection script reads about where it runs: the repository's
 * identity, the current change, the worktree's journal, the plugin's version
 * and the harness. Every value a script can measure is measured here; the
 * agent states the rest, and the session block records which is which.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { consumerRoot, readConfig } from "../../../../shared/consumer.ts";
import { jigHome } from "../../../../shared/config-layers.ts";
import {
  type IssueKeys,
  issueKeysOrNull,
  keyFromBranch,
} from "../../../do-item/scripts/lib/tracker/keys.ts";
import { DEFAULT_BRANCH_PATTERN } from "../../../drive-pr/scripts/lib/pr-policy.ts";
import {
  type Change,
  type Harness,
  parseObject,
  type Session,
} from "./events.ts";

/**
 * The longest one git call may take. A call stalled on the repository's
 * storage throws rather than reading as "no answer", which could name
 * another repository or journal.
 */
const GIT_TIMEOUT_MS = 60_000;

/** A git call that did not finish within `GIT_TIMEOUT_MS`. */
export class GitTimeoutError extends Error {
  override name = "GitTimeoutError";
  readonly code = "git-timeout";
}

/** When every git call must have finished, in epoch milliseconds; null for none. */
let gitDeadline: number | null = null;

/**
 * Run `fn` with every git call cut to the time left before `deadline` (epoch
 * milliseconds), for a caller that holds itself to a limit of its own. A call
 * asked for once none is left throws `GitTimeoutError` without starting.
 */
export async function withGitDeadline<T>(
  deadline: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = gitDeadline;
  gitDeadline = deadline;
  try {
    return await fn();
  } finally {
    gitDeadline = previous;
  }
}

function runGit(args: string[], cwd: string) {
  const timeout =
    gitDeadline === null
      ? GIT_TIMEOUT_MS
      : Math.min(GIT_TIMEOUT_MS, gitDeadline - Date.now());
  if (timeout <= 0)
    throw new GitTimeoutError(
      `git ${args.join(" ")} was not started: the caller's time limit has passed`,
    );
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
    throw new GitTimeoutError(
      `git ${args.join(" ")} did not finish within ${Math.ceil(timeout / 1000)} seconds`,
    );
  return r;
}

function git(args: string[], cwd = consumerRoot()): string | null {
  const r = runGit(args, cwd);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/**
 * A repository's name as every worktree and clone of it agrees on it: the
 * `origin` remote without protocol, user or `.git` suffix
 * (`github.com/example/web`), else `local/<folder>-<hash>` for a repository
 * with no remote, named after the folder of its shared git directory and the
 * hash of that folder's path.
 */
export function normalizeRemote(url: string): string {
  let rest = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme !== null) {
    rest = rest.slice(scheme[0].length);
    rest = rest.replace(/^[^@/]*@/, "");
    rest = rest.replace(/^([^/:]+):\d+\//, "$1/");
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(rest);
    if (scp !== null) rest = `${scp[1]}/${scp[2]}`;
  }
  return rest.replace(/^\/+/, "").toLowerCase();
}

export function repositoryId(root = consumerRoot()): string {
  const remote = git(["remote", "get-url", "origin"], root);
  if (remote !== null && remote !== "") return normalizeRemote(remote);
  const common = git(["rev-parse", "--git-common-dir"], root);
  const folder = common === null ? root : dirname(resolve(root, common));
  // The folder's name alone would give two unrelated repositories of one
  // name the same identity; its path tells them apart.
  const path = createHash("sha256").update(resolve(folder)).digest("hex");
  return `local/${basename(folder)}-${path.slice(0, 12)}`;
}

/**
 * The issue key a branch name carries, in the tracker's key shape, or `null`
 * when the shape is unknown. A key that names its team (`ENG-12`) is found
 * anywhere in the name. A key a branch carries as a number alone is read
 * only where the branch-name pattern (`pull_requests.branch_name`) puts it,
 * since a number elsewhere in a name (`v2-retry`, `fix-3-tests`) is no key.
 */
export function issueFromBranch(
  branch: string,
  keys: IssueKeys | null,
  pattern: string = DEFAULT_BRANCH_PATTERN,
): string | null {
  if (keys === null) return null;
  if (new RegExp(`^(?:${keys.branchSource})$`).test("1"))
    return keyFromBranch(branch, keys, pattern);
  const match = new RegExp(
    `(?:^|[^A-Za-z0-9])(${keys.branchSource})(?![0-9])`,
    "i",
  ).exec(branch);
  return match === null ? null : keys.fromBranch(match[1] as string);
}

/** The configured branch-name pattern, or the default. */
function branchPattern(): string {
  const section = readConfig().pull_requests as
    | Record<string, unknown>
    | undefined;
  const pattern = section?.branch_name;
  return typeof pattern === "string" ? pattern : DEFAULT_BRANCH_PATTERN;
}

/** The change a finding is about, as far as git can tell. */
export function currentChange(root = consumerRoot()): Change {
  const branch = git(["branch", "--show-current"], root) || null;
  return {
    repository: repositoryId(root),
    branch,
    pull_request: null,
    issue:
      branch === null
        ? null
        : issueFromBranch(branch, issueKeysOrNull(), branchPattern()),
  };
}

/** The worktree's own git directory, absolute. */
export function gitDir(root = consumerRoot()): string {
  const dir = git(["rev-parse", "--absolute-git-dir"], root);
  if (dir === null) throw new Error(`not a git repository: ${root}`);
  return dir;
}

/**
 * The worktree's journal. The default lives in the worktree's own git
 * directory, which git never tracks and which goes when the worktree goes.
 * A configured path that git would track is refused.
 */
export function journalPath(
  configured: string | null,
  root = consumerRoot(),
): string {
  if (configured === null)
    return join(gitDir(root), "jig", "reflection-journal.jsonl");
  const top = git(["rev-parse", "--show-toplevel"], root);
  if (top !== null) {
    const inside = relative(resolve(top), configured);
    // Outside the repository only when its first segment is `..`: a name
    // such as `..notes` is a directory inside it.
    const segments = inside.split(/[\\/]/);
    const within = inside !== "" && segments[0] !== ".." && !isAbsolute(inside);
    if (within && !segments.includes(".git")) {
      const ignored = runGit(["check-ignore", "-q", "--no-index", inside], top);
      if (ignored.status !== 0)
        throw new Error(
          `reflection.journal (${configured}) is a path git would track; choose a path the repository ignores`,
        );
      // An ignore rule does not untrack a file already committed.
      const tracked = runGit(
        ["ls-files", "--error-unmatch", "--", inside],
        top,
      );
      if (tracked.status === 0)
        throw new Error(
          `reflection.journal (${configured}) is a file git already tracks; choose a path that is not committed`,
        );
    }
  }
  return configured;
}

/**
 * Where a removed worktree's unsent findings wait for the next `reflect`.
 * The folder name keeps the repository readable and adds a hash of its full
 * identity, since two identities can read alike once separators are replaced.
 */
export function pendingDir(repository: string): string {
  const readable = repository.replace(/[^A-Za-z0-9._-]+/g, "_");
  const hash = createHash("sha256").update(repository).digest("hex");
  return join(jigHome(), "pending", `${readable}-${hash.slice(0, 16)}`);
}

/** The plugin's version, from its own manifest beside the skills. */
export function jigVersion(scriptDir: string): string | null {
  let dir = scriptDir;
  for (let i = 0; i < 6; i++) {
    for (const manifest of [".claude-plugin", ".codex-plugin"]) {
      const file = join(dir, manifest, "plugin.json");
      if (existsSync(file)) {
        // An unreadable manifest is a broken plugin copy: say so rather
        // than record an unknown version.
        const version = parseObject(readFileSync(file, "utf8"), file).version;
        return typeof version === "string" ? version : null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

type Env = Record<string, string | undefined>;

/**
 * The harness, from the variables it sets: Claude Code sets `CLAUDECODE` and
 * `CLAUDE_CODE_ENTRYPOINT`; Codex sets variables named `CODEX_…`; a wrapper
 * that runs the harness adds its own (Herdr's `HERDR_ENV=1`, Conductor's
 * `CONDUCTOR_…`). `null` when nothing identifies one.
 */
export function detectHarness(env: Env = process.env): Harness | null {
  const names = Object.keys(env);
  let name: string | null = null;
  if (env.CLAUDECODE !== undefined) name = "claude-code";
  else if (names.some((key) => key.startsWith("CODEX_"))) name = "codex";
  let wrapper: string | null = null;
  if (env.HERDR_ENV === "1") wrapper = "herdr";
  else if (names.some((key) => key.startsWith("CONDUCTOR_")))
    wrapper = "conductor";
  if (name === null && wrapper === null) return null;
  return {
    name,
    version: null,
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT ?? null,
    wrapper,
  };
}

const STATABLE = ["skills", "model", "mode", "harness"] as const;

/**
 * The session block: measured values filled in, the agent's stated values
 * laid over them, and `stated` listing every field the agent supplied. A
 * value nobody knows stays `null`.
 */
export function sessionBlock(
  scriptDir: string,
  stated: Record<string, unknown> = {},
  env: Env = process.env,
): Session {
  const session: Session = {
    jig_version: jigVersion(scriptDir),
    skills: [],
    harness: detectHarness(env),
    model: null,
    mode: null,
    stated: [],
  };
  for (const field of STATABLE) {
    if (stated[field] === undefined) continue;
    if (field === "harness") {
      const given = stated.harness as Partial<Harness> | null;
      session.harness =
        given === null
          ? null
          : {
              name: given.name ?? session.harness?.name ?? null,
              version: given.version ?? session.harness?.version ?? null,
              entrypoint:
                given.entrypoint ?? session.harness?.entrypoint ?? null,
              wrapper: given.wrapper ?? session.harness?.wrapper ?? null,
            };
    } else
      (session as unknown as Record<string, unknown>)[field] = stated[field];
    session.stated.push(field);
  }
  return session;
}
