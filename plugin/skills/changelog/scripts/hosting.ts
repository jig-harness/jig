// What only the hosting service knows, behind one interface so a second
// service can be added without touching the commands: the repository's
// default branch, and whether the last release run on the integration branch
// succeeded. GitHub is read through `gh`; without `gh`, or on another host,
// each answer degrades to "unknown" and no command fails for it.
import { swallow } from "../../../shared/errors.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { decodeJson, isRecord } from "../../../shared/guards.ts";
import { gitEnv, tryGit } from "./notes-dir.ts";
import { parseRemote } from "./remote.ts";

/** Runs `gh` with `args` in `cwd`; its output, or null when it cannot answer. */
export type Gh = (args: string[], cwd: string) => string | null;

const GH_TIMEOUT_MS = 30_000;

/** `gh`, with a deadline; null when it is missing, signed out or fails. */
export const runGh: Gh = (args, cwd) => {
  const result = spawnSync("gh", args, {
    cwd,
    env: gitEnv(),
    timeout: GH_TIMEOUT_MS,
  });
  return result.error || result.status !== 0 ? null : result.stdout;
};

export type RunState = "success" | "failure" | "running" | "none" | "unknown";

/** The last run of the release workflow on the integration branch. */
export interface ReleaseRun {
  state: RunState;
  /** One sentence for a person. */
  detail: string;
  url?: string;
}

/** A hosting service the commands can ask. */
export interface Hosting {
  name: string;
  /** The repository's default branch; null when the service does not say. */
  defaultBranch(): string | null;
  /** The last release run on `branch`. */
  lastReleaseRun(branch: string): ReleaseRun;
}

/** The text of a field of a run `gh` listed; undefined when it is not text. */
const text = (run: Record<string, unknown>, key: string): string | undefined =>
  typeof run[key] === "string" ? run[key] : undefined;

function isRuns(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

/** GitHub, through `gh`. */
export function github(root: string, gh: Gh = runGh): Hosting {
  return {
    name: "GitHub",
    defaultBranch() {
      const name = gh(
        [
          "repo",
          "view",
          "--json",
          "defaultBranchRef",
          "-q",
          ".defaultBranchRef.name",
        ],
        root,
      )?.trim();
      return name && /^[^\s~^:?*[\\]+$/.test(name) ? name : null;
    },
    lastReleaseRun(branch) {
      const out = gh(
        [
          "run",
          "list",
          "--branch",
          branch,
          "--limit",
          "30",
          "--json",
          "workflowName,status,conclusion,url,headSha",
        ],
        root,
      );
      if (out === null)
        return {
          state: "unknown",
          detail:
            "gh could not answer (not installed, not signed in, or offline)",
        };
      let runs: Record<string, unknown>[];
      try {
        runs = decodeJson(out, isRuns, "gh run list");
      } catch (error) {
        swallow(error, "gh run list answered with something unreadable");
        return {
          state: "unknown",
          detail: "gh answered with something unreadable",
        };
      }
      // The newest run first. The release workflow is the one named exactly
      // `release` (the `name:` of a release.yml), in any letter case: a
      // workflow that only mentions the word, such as a release-notes
      // drafter, is not it.
      const run = runs.find((r) =>
        /^release$/i.test(text(r, "workflowName")?.trim() ?? ""),
      );
      if (!run)
        return { state: "none", detail: `no release run on ${branch} yet` };
      const sha = text(run, "headSha");
      const at = sha ? ` on ${sha.slice(0, 7)}` : "";
      const link = text(run, "url");
      const url = link ? { url: link } : {};
      const conclusion = text(run, "conclusion");
      if (text(run, "status") !== "completed")
        return {
          state: "running",
          detail: `the last release run${at} is still going`,
          ...url,
        };
      return conclusion === "success"
        ? {
            state: "success",
            detail: `the last release run${at} succeeded`,
            ...url,
          }
        : {
            state: "failure",
            detail: `the last release run${at} ended ${conclusion ?? "without a result"}`,
            ...url,
          };
    },
  };
}

/**
 * The hosting service the `origin` remote is on, when Jig can ask it; null
 * for a repository without a remote or on a host with no adapter.
 */
export function hostingFor(root: string, gh: Gh = runGh): Hosting | null {
  const address = tryGit(root, ["remote", "get-url", "origin"])?.trim();
  const host = address ? parseRemote(address)?.host : undefined;
  return host && /(^|\.)github/.test(host) ? github(root, gh) : null;
}
