/**
 * The drive loop's consumer values (`scripts/lib/overlay.ts`): each optional,
 * each with its mechanism default, and the environment overrides winning over
 * the configuration file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  reviewerLabel,
  reviewsDrafts,
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
    overlay('review:\n  bots: ["rev[bot]"]\n');
    expect(reviewerApp()).toBe("");
    expect(reviewerLabel()).toBe("the AI reviewer");
    expect(isReviewerCheck(run("anything"))).toBe(true);
    expect(isReviewerCheck(run("anything", "lint"))).toBe(false);
    expect(isReviewerLogin("rev[bot]")).toBe(true);
    expect(isReviewerLogin("someone")).toBe(false);
    expect(isReviewerLogin("")).toBe(false);
  });

  it("a repository with no configuration file drives on the defaults", () => {
    process.env.JIG_OVERLAY = join(dir, "absent.yaml");
    expect(reviewerApp()).toBe("");
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
  });

  it("reads the configuration file, and the environment overrides it", () => {
    overlay(
      'review:\n  reviewer_check_pattern: "^Bot review$"\n  sticky_marker: "<!-- bot -->"\n  reviewed_sha_marker: bot-sha\n',
    );
    expect(reviewerCheckPattern()).toBe("^Bot review$");
    expect(stickyMarker()).toBe("<!-- bot -->");
    expect(reviewedShaMarker()).toBe("bot-sha");
    process.env.DRIVE_PR_REVIEWER_CHECK = "^env$";
    process.env.DRIVE_PR_STICKY_MARKER = "<!-- env -->";
    process.env.DRIVE_PR_SHA_MARKER = "env-sha";
    expect(reviewerCheckPattern()).toBe("^env$");
    expect(stickyMarker()).toBe("<!-- env -->");
    expect(reviewedShaMarker()).toBe("env-sha");
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
