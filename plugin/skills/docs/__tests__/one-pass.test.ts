/**
 * The one pass end to end: scratch repositories with a docs tree, the pass
 * spawned in them, its report read as JSON and as text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { cleanEnv, doc, git, repository, runDocs, write } from "./helpers.ts";

const SCHEMA = readFileSync(
  join(import.meta.dir, "fixtures", "frontmatter-check", "schema.yaml"),
  "utf8",
);
const GENERATOR = join(
  import.meta.dir,
  "..",
  "scripts",
  "index",
  "generate-index.ts",
);
const TODAY = { LAST_UPDATED_TODAY: "2026-10-28" };

interface Json {
  base: string | null;
  project: { type: string; evidence: string };
  checks: { name: string; status: string; detail: string }[];
  findings: {
    file: string;
    check: string;
    severity: string;
    message: string;
  }[];
  missing: string[];
}

const json = (stdout: string) => JSON.parse(stdout) as Json;
const status = (report: Json, name: string) =>
  report.checks.find((c) => c.name === name)?.status;
const about = (report: Json, check: string) =>
  report.findings.filter((f) => f.check === check);

/**
 * A service with a governed docs tree on `main`, then a branch that edits an
 * approved page's body without its date and adds a scar, adds a page with a
 * wrong status and does not regenerate the index.
 */
function governedService(): string {
  const root = repository({
    Dockerfile: "FROM scratch\n",
    "AGENTS.md": "# Instructions\n",
    "docs/.frontmatter-schema.yaml": SCHEMA,
    "docs/approved.md": doc({ status: "approved", last_updated: "2026-10-01" }),
    "docs/old-draft.md": doc({ status: "draft", last_updated: "2025-01-01" }),
  });
  const generate = spawnSync(process.execPath, [GENERATOR], {
    cwd: root,
    env: cleanEnv({ DOCS_DIR: "docs" }),
  });
  expectSpawnExit({ ...generate, exitCode: generate.status }, 0);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "index");
  git(root, "checkout", "-qb", "work");
  write(
    root,
    "docs/approved.md",
    doc(
      { status: "approved", last_updated: "2026-10-01" },
      "# A page\n\n- ~~old claim~~ new claim\n",
    ),
  );
  write(root, "docs/new-page.md", doc({ status: "completed" }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "edit");
  return root;
}

describe("a governed tree with one finding of each kind", () => {
  const root = governedService();
  const run = runDocs(root, ["--json"], TODAY);
  const report = json(run.stdout);

  test("exits 1 and compares with the default branch", () => {
    expectSpawnExit(run, 1);
    expect(report.base).toBe("main");
  });

  test("reports the frontmatter errors, holding the added page to required_new", () => {
    expect(about(report, "frontmatter")).toEqual([
      expect.objectContaining({
        file: "docs/new-page.md",
        message: "new doc missing required field: description",
      }),
      expect.objectContaining({
        file: "docs/new-page.md",
        severity: "error",
        message: "invalid status 'completed' (did you mean 'approved'?)",
      }),
    ]);
  });

  test("reports the index drift", () => {
    expect(status(report, "index")).toBe("findings");
    expect(about(report, "index").map((f) => f.file)).toContain(
      "docs/INDEX.md",
    );
  });

  test("reports the body edited without its date, and the scar", () => {
    expect(about(report, "last_updated")).toEqual([
      expect.objectContaining({ file: "docs/approved.md" }),
    ]);
    expect(about(report, "scars")).toEqual([
      expect.objectContaining({
        file: "docs/approved.md",
        message: expect.stringContaining("~~old claim~~"),
      }),
    ]);
  });

  test("warns of the stale draft without failing on it", () => {
    expect(about(report, "stale drafts")).toEqual([
      expect.objectContaining({
        file: "docs/old-draft.md",
        severity: "warning",
        message: expect.stringContaining("665 days ago"),
      }),
    ]);
  });

  test("plans the documents a service lacks", () => {
    expect(report.project).toEqual({ type: "service", evidence: "Dockerfile" });
    expect(report.missing).toEqual(
      expect.arrayContaining(["runbooks", "architecture", "activity-log"]),
    );
    expect(report.missing).not.toContain("index");
    expect(report.missing).not.toContain("frontmatter-schema");
    expect(report.missing).not.toContain("instruction-layer");
  });

  test("prints the same findings by file as text", () => {
    const text = runDocs(root, [], TODAY);
    expectSpawnExit(text, 1);
    expect(text.stdout).toContain("\nFindings by file\n");
    expect(text.stdout).toContain(
      "\n  docs/INDEX.md\n    error    index         stale",
    );
    expect(text.stdout).toMatch(
      /\n {2}docs\/approved\.md\n {4}error {4}last_updated .*\n {4}error {4}scars/,
    );
    expect(text.stdout).toContain("  docs/runbooks/: runbooks");
  });
});

describe("what the repository configures or lacks", () => {
  test("no docs tree: every check skipped, the tree itself planned", () => {
    const root = repository({ "README.md": "# Tool\n" });
    const run = runDocs(root, ["--json"]);
    expectSpawnExit(run, 0);
    const report = json(run.stdout);
    expect(new Set(report.checks.map((c) => c.status))).toEqual(
      new Set(["skipped"]),
    );
    expect(report.missing).toContain("docs-tree");
    expect(report.project.type).toBe("unknown");
  });

  test("a configured root and threshold are used, the schema found under it", () => {
    const root = repository({
      ".config/jig.yaml": "docs:\n  root: handbook\n  stale_after_days: 30\n",
      "handbook/meta/frontmatter-schema.yaml": SCHEMA,
      "handbook/draft.md": doc({ status: "draft", last_updated: "2026-09-01" }),
    });
    const report = json(runDocs(root, ["--json"], TODAY).stdout);
    expect(status(report, "frontmatter")).toBe("ok");
    expect(about(report, "stale drafts")).toEqual([
      expect.objectContaining({ file: "handbook/draft.md" }),
    ]);
  });

  test("an unknown field or a missing configured path is refused with its source", () => {
    const unknown = repository({ ".config/jig.yaml": "docs:\n  folder: x\n" });
    const refused = runDocs(unknown);
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("docs has unknown field folder");
    expect(refused.stderr).toContain(".config/jig.yaml");
    const missing = repository({
      ".config/jig.yaml": "docs:\n  schema: docs/schema.yaml\n",
    });
    const absent = runDocs(missing);
    expectSpawnExit(absent, 2);
    expect(absent.stderr).toContain("docs.schema names docs/schema.yaml");
  });

  test("a check that cannot run makes the pass exit 2", () => {
    const root = repository({ "docs/a.md": doc({}) });
    const run = runDocs(root, ["--json", "--base", "no-such-ref"]);
    expectSpawnExit(run, 2);
    expect(status(json(run.stdout), "last_updated")).toBe("failed");
  });

  test("a check that cannot run wins over another check's error", () => {
    const run = runDocs(governedService(), ["--json", "--base", "no-such-ref"]);
    expectSpawnExit(run, 2);
    const report = json(run.stdout);
    expect(status(report, "last_updated")).toBe("failed");
    expect(about(report, "scars").length).toBeGreaterThan(0);
  });

  test("a configured base branch that does not resolve is refused", () => {
    const root = repository({
      ".config/jig.yaml": "repository:\n  base_branch: trunk\n",
      "docs/a.md": doc({}),
    });
    const run = runDocs(root, ["--json"]);
    expectSpawnExit(run, 2);
    expect(run.stderr).toContain("repository.base_branch is trunk");
  });

  test("an unusable adr section is refused, not replaced by discovery", () => {
    const cases: [string, string][] = [
      ["adr: []\n", "adr must be an object"],
      ["adr:\n  directory: handbook/missing\n", "not a directory"],
    ];
    for (const [config, message] of cases) {
      const run = runDocs(repository({ ".config/jig.yaml": config }));
      expectSpawnExit(run, 2);
      expect(run.stderr).toContain(message);
    }
  });

  for (const root of ["docs", "./docs", "docs/"])
    test(`the last_updated check reports only documents under ${root}`, () => {
      const repo = repository({
        ".config/jig.yaml": `docs:\n  root: ${root}\n`,
        "docs/a.md": doc({ last_updated: "2026-10-01" }),
        "notes.md": doc({ last_updated: "2026-10-01" }),
      });
      git(repo, "checkout", "-qb", "work");
      write(
        repo,
        "notes.md",
        doc({ last_updated: "2026-10-01" }, "# Changed\n"),
      );
      write(
        repo,
        "docs/a.md",
        doc({ last_updated: "2026-10-01" }, "# Changed\n"),
      );
      git(repo, "commit", "-qam", "edit");
      const report = json(runDocs(repo, ["--json"], TODAY).stdout);
      expect(report.checks).toContainEqual(
        expect.objectContaining({ name: "last_updated", status: "findings" }),
      );
      expect(about(report, "last_updated")).toEqual([
        expect.objectContaining({ file: "docs/a.md" }),
      ]);
    });

  test("a page moved within the tree is not held to required_new", () => {
    const repo = repository({
      "docs/.frontmatter-schema.yaml": SCHEMA,
      "docs/old-name.md": doc({ status: "approved" }),
    });
    git(repo, "checkout", "-qb", "work");
    git(repo, "mv", "docs/old-name.md", "docs/new-name.md");
    git(repo, "commit", "-qm", "move");
    git(repo, "config", "diff.renames", "false");
    const report = json(runDocs(repo, ["--json"], TODAY).stdout);
    expect(status(report, "frontmatter")).toBe("ok");
    expect(about(report, "frontmatter")).toEqual([]);
  });

  test("a configured deferral check runs over every document", () => {
    const root = repository({
      ".config/deferral-references.yaml":
        "version: 1\ninclude: ['docs/**/*.md']\nitems: ['\\bITEM-\\d+\\b']\n",
      "docs/a.md": doc({}, "# A\n\nThe rest will be filed later.\n"),
    });
    const run = runDocs(root, ["--json"]);
    expectSpawnExit(run, 1);
    expect(about(json(run.stdout), "deferrals")).toEqual([
      expect.objectContaining({ file: "docs/a.md", severity: "error" }),
    ]);
  });

  test("--type overrides the detected type; an unknown one is refused", () => {
    const root = repository({ "package.json": '{"private": true}\n' });
    const library = json(runDocs(root, ["--json", "--type", "library"]).stdout);
    expect(library.project).toEqual({ type: "library", evidence: "--type" });
    expect(library.missing).toContain("reference");
    expectSpawnExit(runDocs(root, ["--type", "website"]), 2);
  });
});
