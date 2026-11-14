/** Prove the PR's repository and remote head before opening its checkout. */
import { isRecord } from "../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import {
  type Context,
  type RunOptions,
  type RunResult,
  HerdrError,
  output,
} from "../../../shared/orca-workspace/runner.ts";
import { repoOfUrl } from "../../../skills/drive-pr/scripts/lib/repo-url.ts";

type Proof<T> = Outcome<T, "pr-head-unverified">;
const refuse = (reason: string) =>
  failed("pr-head-unverified" as const, reason);
interface Head {
  sha: string;
  repo: string;
  url: string;
}

/** An asynchronous forge read; absent on the existing workspace-open path. */
export type HeadReader = (
  argv: string[],
  options: RunOptions,
) => Promise<RunResult>;

function parseHead(text: string, branch: string): Proof<Head> {
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return refuse("the head response is not JSON");
  }
  if (!isRecord(meta)) return refuse("the head response is not an object");
  if (meta.state !== "OPEN") return refuse("it is no longer open");
  if (meta.isCrossRepository !== false)
    return refuse(
      "a fork or unknown head repository cannot be driven through origin",
    );
  if (
    meta.headRefName !== branch ||
    typeof meta.headRefOid !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(meta.headRefOid)
  )
    return refuse("its head branch or commit changed or could not be read");
  const owner = isRecord(meta.headRepositoryOwner)
    ? meta.headRepositoryOwner.login
    : undefined;
  const name = isRecord(meta.headRepository)
    ? meta.headRepository.name
    : undefined;
  if (
    typeof owner !== "string" ||
    owner === "" ||
    typeof name !== "string" ||
    name === ""
  )
    return refuse("its head repository could not be read");
  if (typeof meta.url !== "string" || !URL.canParse(meta.url))
    return refuse("its URL could not be read");
  return ok({
    sha: meta.headRefOid,
    repo: `${owner}/${name}`.toLowerCase(),
    url: meta.url,
  });
}

async function requireOrigin(
  ctx: Context,
  clone: string,
  head: Head,
): Promise<Proof<void>> {
  const resolve = async (argv: string[], options: { timeoutSec: number }) => {
    const result = ctx.run(argv, {
      cwd: clone,
      timeoutMs: options.timeoutSec * 1000,
    });
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  for (const mode of [[], ["--push"]]) {
    const urls = ctx.run([
      "git",
      "-C",
      clone,
      "remote",
      "get-url",
      ...mode,
      "--all",
      "origin",
    ]);
    if (urls.status !== 0)
      return refuse(
        `cannot read origin's URLs (exit ${urls.status}): ${output(urls)}`,
      );
    if (urls.stdout.trim() === "") return refuse("origin reported no URLs");
    let repositories: string[];
    try {
      repositories = await Promise.all(
        urls.stdout
          .trim()
          .split("\n")
          .map((url) =>
            repoOfUrl(url, undefined, resolve, head.url, clone, resolve),
          ),
      );
    } catch (error) {
      // The run's own limit is the caller's to classify as lost time.
      if (error instanceof HerdrError) throw error;
      return refuse(
        `origin's transport could not be verified: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (repositories.some((resolved) => resolved.toLowerCase() !== head.repo))
      return refuse(
        `origin does not point at the head repository ${head.repo}`,
      );
  }
  return ok(undefined);
}

export async function resolvePullRequestHead(
  ctx: Context,
  clone: string,
  pr: number,
  branch: string,
  repository?: string,
  readForge?: HeadReader,
): Promise<Proof<string>> {
  const result = await readHead(ctx, clone, pr, branch, repository, readForge);
  return result.ok ? result : refuse(`PR #${pr}: ${result.failure.reason}`);
}

async function readHead(
  ctx: Context,
  clone: string,
  pr: number,
  branch: string,
  repository?: string,
  readForge?: HeadReader,
): Promise<Proof<string>> {
  const read = await (
    readForge ?? (async (argv, options) => ctx.run(argv, options))
  )(
    [
      "gh",
      "pr",
      "view",
      String(pr),
      ...(repository === undefined ? [] : ["--repo", repository]),
      "--json",
      "state,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,url",
    ],
    { cwd: clone },
  );
  if (read.status !== 0)
    return refuse(
      `cannot read its head (exit ${read.status}): ${output(read)}`,
    );
  const head = parseHead(read.stdout, branch);
  if (!head.ok) return head;
  if (repository !== undefined && head.value.repo !== repository.toLowerCase())
    return refuse(
      `its head repository is not the expected repository ${repository}`,
    );
  const origin = await requireOrigin(ctx, clone, head.value);
  if (!origin.ok) return origin;
  const remote = ctx.run([
    "git",
    "-C",
    clone,
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/heads/${branch}`,
  ]);
  if (remote.status !== 0)
    return refuse(
      `cannot verify origin's head (exit ${remote.status}): ${output(remote) || "the branch is absent"}`,
    );
  const fields = remote.stdout.trim().split(/\s+/);
  if (
    fields.length !== 2 ||
    fields[0] !== head.value.sha ||
    fields[1] !== `refs/heads/${branch}`
  )
    return refuse("origin's branch does not match its reported head commit");
  return ok(head.value.sha);
}
