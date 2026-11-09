import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  automationLabelFindings,
  fileFindings,
  unlabelledSteps,
} from "../scripts/lib/automation-fit.ts";
import { load } from "../../../shared/yaml.ts";

/** The unlabelled steps of one workflow's text. */
const steps = (text: string) => unlabelledSteps(load(text));

const scratch = mkdtempSync(join(tmpdir(), "automation-fit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A repository holding `files`, and the paths it tracks. */
function repo(files: Record<string, string>): {
  root: string;
  tracked: string[];
} {
  const root = join(scratch, `repo-${n++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, tracked: Object.keys(files) };
}

const CREATE = (labels?: string) => `on: { schedule: [{ cron: "0 5 * * 1" }] }
jobs:
  regen:
    steps:
      - uses: actions/checkout@v4
      - name: Open the regeneration
        uses: peter-evans/create-pull-request@v6
        with:
          branch: regen${labels === undefined ? "" : `\n          labels: ${labels}`}
`;

const GH = (run: string) => `jobs:
  sync:
    steps:
      - run: ${JSON.stringify(run)}
`;

describe("the audit's automation label finding", () => {
  it("names each workflow step that opens a pull request with no automation: label", () => {
    expect(steps(CREATE())).toEqual(["regen › Open the regeneration"]);
    expect(steps(CREATE("docs, needs-review"))).toEqual([
      "regen › Open the regeneration",
    ]);
    expect(steps(GH("gh pr create --fill --label docs"))).toEqual([
      "sync › step 1",
    ]);
    expect(
      steps(GH('gh pr create --fill --label "docs,automationish" -l x')),
    ).toEqual(["sync › step 1"]);
  });

  it("says nothing of a step that applies an automation: label, or that opens no pull request", () => {
    expect(steps(CREATE("docs, automation:docs-sync"))).toEqual([]);
    expect(
      steps(GH("gh pr create --fill --label automation:docs-sync")),
    ).toEqual([]);
    expect(steps(GH('gh pr create --fill -l "automation:docs-sync"'))).toEqual(
      [],
    );
    expect(
      steps(GH('gh pr create --fill --label "docs,automation:docs-sync"')),
    ).toEqual([]);
    expect(
      steps(GH("gh pr create --fill --label docs -l automation:docs-sync")),
    ).toEqual([]);
    expect(
      steps(GH("gh pr create --fill --label=docs,automation:docs-sync")),
    ).toEqual([]);
    expect(steps(GH("gh pr list --state open"))).toEqual([]);
  });

  it("reports a repository's unlabelled workflows once, as a suggestion, and none for a template or a workflow that does not parse", () => {
    const { root, tracked } = repo({
      ".github/workflows/regen.yml": CREATE(),
      ".github/workflows/sync.yaml": GH("gh pr create --fill"),
      ".github/workflows/labelled.yml": CREATE("automation:docs-sync"),
      ".github/workflows/broken.yml": "jobs: [gh pr create, workflow\n",
      "templates/.github/workflows/example.yml": CREATE(),
      "docs/howto.md": "Run gh pr create by hand.\n",
    });
    const findings = automationLabelFindings(root, tracked);
    expect(findings.map((f) => [f.id, f.severity])).toEqual([
      ["suggestion:automation-labels", "suggestion"],
    ]);
    expect(findings[0]?.message).toContain(
      ".github/workflows/regen.yml (regen › Open the regeneration)",
    );
    expect(findings[0]?.message).toContain(".github/workflows/sync.yaml");
    expect(findings[0]?.message).not.toContain("labelled.yml");
    expect(findings[0]?.message).not.toContain("broken.yml");
    expect(findings[0]?.message).not.toContain("templates/");
  });

  it("is read whether or not the repository has a configuration, beside the tracker's findings only where it has one", () => {
    const { root, tracked } = repo({
      ".github/workflows/regen.yml": CREATE(),
    });
    const tracker = { issue_tracker: { adapter: "github" } };
    const ids = (configured: boolean) =>
      fileFindings(tracker, tracked, { root }, { configured }).map((f) => f.id);
    expect(ids(false)).toEqual(["suggestion:automation-labels"]);
    expect(ids(true)).toEqual([
      "suggestion:issue_tracker.sweep",
      "suggestion:automation-labels",
    ]);
  });
});
