/**
 * The drive loop's consumer values (`scripts/lib/overlay.ts`): each optional,
 * each with its mechanism default, and the environment overrides winning over
 * the configuration file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseBranch,
  changeAreasCatalogPath,
  ciHoldLabelSetting,
  isReviewerLogin,
  requiredChecksSetting,
  reviewedShaMarker,
  reviewerApp,
  reviewerCheckPattern,
  reviewerEvidence,
  reviewerEvidenceProblem,
  reviewerExpected,
  reviewerLabel,
  reviewsDrafts,
  skipNoticeMarker,
  stickyMarker,
  validationPlanCommand,
} from "../scripts/lib/overlay.ts";
import { isReviewerCheck } from "../scripts/lib/status/evidence.ts";

const KEYS = [
  "JIG_OVERLAY",
  "DRIVE_PR_REVIEWER_APP",
  "DRIVE_PR_BASE_BRANCH",
  "DRIVE_PR_REVIEWER_CHECK",
  "DRIVE_PR_STICKY_MARKER",
  "DRIVE_PR_SHA_MARKER",
  "DRIVE_PR_SKIP_NOTICE_MARKER",
  "DRIVE_PR_REVIEWER_EVIDENCE",
] as const;
let saved: Record<string, string | undefined>;
let dir: string;

function overlay(text: string): void {
  const path = join(dir, `overlay-${Math.random()}.yaml`);
  writeFileSync(path, text);
  process.env.JIG_OVERLAY = path;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "drive-overlay-"));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const run = (app: string, name = "AI review") => ({
  name,
  status: "completed",
  conclusion: "success",
  app,
  title: "",
  id: 1,
  started: null,
});

describe("reviewer identity", () => {
  it("reads review.reviewer_app, and the environment overrides it", () => {
    overlay("review:\n  reviewer_app: from-file\n");
    expect(reviewerApp()).toBe("from-file");
    expect(reviewerLabel()).toBe("'from-file'");
    process.env.DRIVE_PR_REVIEWER_APP = "from-env";
    expect(reviewerApp()).toBe("from-env");
  });

  it("with an app, only that app's check and bot login are the reviewer's", () => {
    overlay('review:\n  reviewer_app: rev\n  bots: ["other[bot]"]\n');
    expect(isReviewerCheck(run("rev"))).toBe(true);
    expect(isReviewerCheck(run("github-actions"))).toBe(false);
    expect(isReviewerLogin("rev[bot]")).toBe(true);
    expect(isReviewerLogin("other[bot]")).toBe(false);
  });

  it("without an app, the check name decides and the sticky author must be a declared bot", () => {
    overlay(
      'review:\n  bots: ["rev[bot]"]\n  reviewer_check_pattern: "^ai[ _-]?review(\\\\s*\\\\(.+\\\\))?$"\n',
    );
    expect(reviewerApp()).toBe("");
    expect(reviewerLabel()).toBe("the AI reviewer");
    expect(isReviewerCheck(run("anything"))).toBe(true);
    expect(isReviewerCheck(run("anything", "lint"))).toBe(false);
    expect(isReviewerLogin("rev[bot]")).toBe(true);
    expect(isReviewerLogin("someone")).toBe(false);
    expect(isReviewerLogin("")).toBe(false);
  });

  it("a reviewer is expected only where the repository or the environment names one", () => {
    overlay('review:\n  bots: ["rev[bot]"]\n');
    expect(reviewerExpected()).toBe(false);
    overlay("review:\n  reviewer_app: rev\n");
    expect(reviewerExpected()).toBe(true);
    overlay('review:\n  reviewer_check_pattern: "^Bot review$"\n');
    expect(reviewerExpected()).toBe(true);
    overlay("review: {}\n");
    process.env.DRIVE_PR_REVIEWER_APP = "from-env";
    expect(reviewerExpected()).toBe(true);
    delete process.env.DRIVE_PR_REVIEWER_APP;
    process.env.DRIVE_PR_REVIEWER_CHECK = "^env$";
    expect(reviewerExpected()).toBe(true);
    process.env.DRIVE_PR_REVIEWER_CHECK = " ";
    expect(reviewerExpected()).toBe(false);
  });

  it("where no reviewer is named, a reviewer-shaped check is an ordinary check", () => {
    overlay('review:\n  bots: ["rev[bot]"]\n');
    expect(isReviewerCheck(run("anything"))).toBe(false);
    expect(isReviewerCheck(run("github-actions"))).toBe(false);
  });

  it("a repository with no configuration file drives on the defaults", () => {
    process.env.JIG_OVERLAY = join(dir, "absent.yaml");
    expect(reviewerApp()).toBe("");
    expect(reviewerExpected()).toBe(false);
    expect(validationPlanCommand()).toBeUndefined();
    expect(reviewsDrafts()).toBeUndefined();
  });

  it("a field of the wrong type is an error, not a default", () => {
    overlay("drive:\n  reviews_drafts: sometimes\n");
    expect(() => reviewsDrafts()).toThrow("drive.reviews_drafts");
    overlay("drive:\n  validation_plan_command: 3\n");
    expect(() => validationPlanCommand()).toThrow(
      "drive.validation_plan_command",
    );
  });
});

describe("base branch and catalog", () => {
  it("reads repository.base_branch, and the environment overrides it", async () => {
    overlay("repository:\n  base_branch: trunk\n");
    expect(await baseBranch(dir)).toBe("trunk");
    process.env.DRIVE_PR_BASE_BRANCH = "main";
    expect(await baseBranch(dir)).toBe("main");
  });

  it("resolves the catalog path against the repository root", () => {
    overlay("drive:\n  change_areas_catalog: tools/catalog.yaml\n");
    expect(changeAreasCatalogPath("/repo")).toBe(
      join("/repo", "tools", "catalog.yaml"),
    );
    overlay("repository: {}\n");
    expect(changeAreasCatalogPath("/repo")).toBeUndefined();
  });
});

describe("reviewer protocol", () => {
  it("defaults to the AI review check and its markers", () => {
    overlay("review:\n  bots: []\n");
    expect(reviewerCheckPattern()).toBe("^ai[ _-]?review(\\s*\\(.+\\))?$");
    expect(stickyMarker()).toBe("<!-- ai-code-review -->");
    expect(reviewedShaMarker()).toBe("ai-reviewed-sha");
    expect(skipNoticeMarker()).toBe("ai-review-skip-notice");
  });

  it("reads the configuration file, and the environment overrides it", () => {
    overlay(
      'review:\n  reviewer_check_pattern: "^Bot review$"\n  sticky_marker: "<!-- bot -->"\n  reviewed_sha_marker: bot-sha\n  skip_notice_marker: bot-skip\n',
    );
    expect(reviewerCheckPattern()).toBe("^Bot review$");
    expect(stickyMarker()).toBe("<!-- bot -->");
    expect(reviewedShaMarker()).toBe("bot-sha");
    expect(skipNoticeMarker()).toBe("bot-skip");
    process.env.DRIVE_PR_REVIEWER_CHECK = "^env$";
    process.env.DRIVE_PR_STICKY_MARKER = "<!-- env -->";
    process.env.DRIVE_PR_SHA_MARKER = "env-sha";
    process.env.DRIVE_PR_SKIP_NOTICE_MARKER = "env-skip";
    expect(reviewerCheckPattern()).toBe("^env$");
    expect(stickyMarker()).toBe("<!-- env -->");
    expect(reviewedShaMarker()).toBe("env-sha");
    expect(skipNoticeMarker()).toBe("env-skip");
  });

  it("a known reviewer app brings its check name and evidence", () => {
    overlay("review:\n  reviewer_app: coderabbitai\n");
    expect(reviewerCheckPattern()).toBe("^CodeRabbit$");
    expect(reviewerEvidence()).toBe("review_object");
    expect(reviewerEvidenceProblem()).toBeNull();
    expect(isReviewerLogin("coderabbitai[bot]")).toBe(true);
    overlay(
      'review:\n  reviewer_app: coderabbitai\n  reviewer_check_pattern: "^Own$"\n',
    );
    expect(reviewerCheckPattern()).toBe("^Own$");
    overlay("review:\n  reviewer_app: rev\n");
    expect(reviewerCheckPattern()).toBe("^ai[ _-]?review(\\s*\\(.+\\))?$");
    expect(reviewerEvidence()).toBe("sticky");
  });

  it("reads review.reviewer_evidence, and the environment overrides it", () => {
    overlay(
      "review:\n  reviewer_app: rev\n  reviewer_evidence: review_object\n",
    );
    expect(reviewerEvidence()).toBe("review_object");
    process.env.DRIVE_PR_REVIEWER_EVIDENCE = "sticky";
    expect(reviewerEvidence()).toBe("sticky");
    delete process.env.DRIVE_PR_REVIEWER_EVIDENCE;
    overlay("review:\n  reviewer_app: rev\n  reviewer_evidence: comments\n");
    expect(() => reviewerEvidence()).toThrow("review.reviewer_evidence");
  });

  it("names the evidence the drive could not read", () => {
    overlay(
      "review:\n  reviewer_app: coderabbitai\n  reviewer_evidence: sticky\n",
    );
    expect(reviewerEvidenceProblem()).toContain("submits pull-request reviews");
    overlay(
      'review:\n  reviewer_check_pattern: "^Bot$"\n  reviewer_evidence: review_object\n',
    );
    expect(reviewerEvidenceProblem()).toContain("no review.reviewer_app");
    overlay("review:\n  reviewer_evidence: review_object\n");
    expect(reviewerEvidenceProblem()).toBeNull();
  });

  /** The list, or the refusal, `draftSkippingReviewers()` gives in a clean subprocess. */
  function skippers(
    commits: { base?: string; bound?: string },
    extra: Record<string, string> = {},
  ): string {
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
        .stdout.toString()
        .trim();
    const repo = join(dir, `repo-${Math.random()}`);
    mkdirSync(repo);
    git(repo, "init", "-q");
    const commit = (yaml: string | undefined): string => {
      mkdirSync(join(repo, ".config"), { recursive: true });
      if (yaml === undefined)
        rmSync(join(repo, ".config/jig.yaml"), { force: true });
      else writeFileSync(join(repo, ".config/jig.yaml"), yaml);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "--allow-empty", "-m", "c");
      return git(repo, "rev-parse", "HEAD");
    };
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      JIG_CONSUMER_ROOT: repo,
      ...extra,
    };
    if (commits.bound !== undefined)
      env.DRIVE_PR_POLICY_BOUND = commit(commits.bound);
    if (commits.base !== undefined)
      env.DRIVE_PR_POLICY_BASE = commit(commits.base);
    commit("review:\n  draft_skipping_reviewers: []\n");
    const r = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { draftSkippingReviewers } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/overlay.ts"))};
try { console.log(JSON.stringify(draftSkippingReviewers())); } catch (e) { console.log(String(e)); }`,
      ],
      { cwd: repo, env },
    );
    return r.stdout.toString().trim();
  }

  it("reads review.draft_skipping_reviewers from the base commit, never the checkout's own file", () => {
    expect(skippers({ base: "review: {}\n" })).toBe("[]");
    expect(
      skippers({
        base: "review:\n  draft_skipping_reviewers: [coderabbitai]\n",
      }),
    ).toBe('["coderabbitai"]');
    expect(
      skippers({ base: "review:\n  draft_skipping_reviewers: [a, a]\n" }),
    ).toContain("review.draft_skipping_reviewers");
  });

  it("ignores the environment and a user layer, standalone or in a driver pass", () => {
    const base = "review: {}\n";
    expect(
      skippers(
        { base },
        { JIG__REVIEW__DRAFT_SKIPPING_REVIEWERS: "[coderabbitai]" },
      ),
    ).toBe("[]");
    expect(
      skippers({ base }, { DRIVE_PR_TARGET: "1", JIG_OVERLAY: join(dir, "x") }),
    ).toBe("[]");
  });

  it("refuses when no base commit is named or the base's review section is not a mapping", () => {
    expect(skippers({})).toContain("the base branch's configuration");
    expect(skippers({ base: "review: false\n" })).toContain(
      "must be a mapping",
    );
    expect(skippers({ base: "review: []\n" })).toContain("must be a mapping");
  });

  it("adds a stacked layer's list to the integration branch's, never removing from it", () => {
    expect(
      skippers({
        bound: "review:\n  draft_skipping_reviewers: [coderabbitai]\n",
        base: "review:\n  draft_skipping_reviewers: []\n",
      }),
    ).toBe('["coderabbitai"]');
    expect(
      skippers({
        bound: "review:\n  draft_skipping_reviewers: [coderabbitai]\n",
        base: "review:\n  draft_skipping_reviewers: [other]\n",
      }),
    ).toBe('["coderabbitai","other"]');
  });
});

describe("CI policy settings", () => {
  it("are unset by default", () => {
    overlay("gates:\n  command: x\n");
    expect(requiredChecksSetting()).toBeUndefined();
    expect(ciHoldLabelSetting()).toBeUndefined();
  });

  it("read the required checks and the hold label", () => {
    overlay(
      'ci:\n  required_checks: [build, "lint · test"]\n  hold_label: "ci:hold"\n',
    );
    expect(requiredChecksSetting()).toEqual(["build", "lint · test"]);
    expect(ciHoldLabelSetting()).toBe("ci:hold");
  });

  it("accept an explicit empty list of required checks", () => {
    overlay("ci:\n  required_checks: []\n");
    expect(requiredChecksSetting()).toEqual([]);
  });

  it("refuse malformed values", () => {
    overlay("ci:\n  required_checks: build\n");
    expect(() => requiredChecksSetting()).toThrow("ci.required_checks");
    overlay('ci:\n  required_checks: ["", x]\n');
    expect(() => requiredChecksSetting()).toThrow("ci.required_checks");
    overlay("ci:\n  hold_label: 3\n");
    expect(() => ciHoldLabelSetting()).toThrow("ci.hold_label");
  });
});
