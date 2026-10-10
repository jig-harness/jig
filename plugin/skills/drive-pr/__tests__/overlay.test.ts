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
  isReviewerLogin,
  reviewerApp,
  reviewerLabel,
  reviewsDrafts,
  validationPlanCommand,
} from "../scripts/lib/overlay.ts";
import { isReviewerCheck } from "../scripts/lib/status/evidence.ts";

const KEYS = [
  "GROUNDWORK_OVERLAY",
  "DRIVE_PR_REVIEWER_APP",
  "DRIVE_PR_BASE_BRANCH",
] as const;
let saved: Record<string, string | undefined>;
let dir: string;

function overlay(text: string): void {
  const path = join(dir, `overlay-${Math.random()}.yaml`);
  writeFileSync(path, text);
  process.env.GROUNDWORK_OVERLAY = path;
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
    process.env.GROUNDWORK_OVERLAY = join(dir, "absent.yaml");
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
