import type {
  CommitCheck,
  Hosting,
  RequiredCheck,
} from "../scripts/hosting.ts";
import { type PlanSources, planTags, type TagPlan } from "../scripts/tag.ts";
import { git, jigYaml, repository, temporary } from "./scratch.ts";

/** A Keep a Changelog file with a release heading for each of `versions`, newest first. */
export const changelog = (...versions: string[]): string =>
  [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    ...versions.flatMap((v) => [
      `## [${v}] - 2026-01-02`,
      "",
      "### Fixed",
      "",
      `- ${v}`,
      "",
    ]),
  ].join("\n");

export const config = (extra = ""): string =>
  jigYaml(`  file: CHANGELOG.md\n  version: { tags: true }${extra}`);

/** A repository on `main` whose first commit released 1.2.0. */
export function released(extra = ""): string {
  return repository({
    "CHANGELOG.md": changelog("1.2.0"),
    ".config/jig.yaml": config(extra),
  });
}

export const head = (root: string, rev = "HEAD"): string =>
  git(root, "rev-parse", rev).trim();

export const env = () => ({ JIG_HOME: temporary("jig-home-") });

export const passed = (
  name: string,
  extra: Partial<CommitCheck> = {},
): CommitCheck => ({
  name,
  kind: "check-run",
  outcome: "passed",
  conclusion: "success",
  app: 15368,
  ...extra,
});

/** A hosting service that answers from `checks` by commit, requiring `required`. */
export function fake(
  checks: Record<string, CommitCheck[]>,
  required: RequiredCheck[] | null = [{ name: "test", apps: [] }],
  reruns: number[] = [],
): Hosting {
  return {
    name: "fake",
    defaultBranch: () => "main",
    lastReleaseRun: () => ({ state: "success", detail: "fine" }),
    requiredChecks: () =>
      required === null
        ? { known: false, detail: "offline" }
        : { known: true, value: required },
    commitChecks: (sha) => ({ known: true, value: checks[sha] ?? [] }),
    rerun: (run) => {
      reruns.push(run);
      return null;
    },
  };
}

/** The plan, origin answering that it holds `tagged`. */
export function plan(
  root: string,
  hosting: Hosting,
  tagged: string[] = ["v1.2.0"],
): TagPlan {
  const sources: PlanSources = { hosting, tags: () => new Set(tagged) };
  const result = planTags(root, sources, env());
  if (result === null) throw new Error("not configured");
  return result;
}

/** What `fn` printed to standard output, and the status it returned. */
export function captured(fn: () => number): { code: number; text: string } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    return { code: fn(), text: lines.join("\n") };
  } finally {
    console.log = log;
  }
}
