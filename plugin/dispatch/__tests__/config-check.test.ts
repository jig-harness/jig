/**
 * `jig dispatch check`: the configuration a tick reads, checked in a
 * checkout with the tick's own readers. Each configuration the tick refuses
 * is read twice, once by a tick from the forge's default branch and once by
 * the check from a checkout holding the same files, and the check must fail
 * with the sentence the tick's receipt carries.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { checkConfiguration } from "../lib/config-check.ts";
import type { TickReceipt } from "../receipts.ts";
import { SLUG, type World, world } from "./fixtures.ts";

const TRACKER = `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`;
const CATALOG = ".config/change-areas.yaml";

/** Put `files` in the world's checkout, where the check reads them. */
function checkout(w: World, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(w.repo, path)), { recursive: true });
    writeFileSync(join(w.repo, path), text);
  }
}

/** The tick's receipt for the world's one repository; a tick that refuses a reading exits 1. */
async function tickOf(
  w: World,
  exit: 0 | 1 = 1,
): Promise<TickReceipt["repos"][number]> {
  const run = await w.dispatch(["--json"]);
  expectSpawnExit(run, exit);
  const receipt = JSON.parse(run.stdout) as TickReceipt;
  const repo = receipt.repos[0];
  if (repo === undefined) throw new Error("the tick read no repository");
  return repo;
}

/** The detail of the tick's failed record whose detail starts with `prefix`. */
function failedDetail(
  repo: TickReceipt["repos"][number],
  prefix: string,
): string {
  const record = repo.records.find((r) => !r.ok && r.detail.startsWith(prefix));
  if (record === undefined)
    throw new Error(
      `no failed record starts with "${prefix}": ${JSON.stringify(repo.records)}`,
    );
  return record.detail;
}

/** Run the check in the world's checkout; it must fail, and its stderr is returned. */
async function failedCheck(w: World): Promise<string> {
  const run = await w.dispatch(["check"]);
  expectSpawnExit(run, 1);
  return run.stderr;
}

describe("jig dispatch check fails with the tick's message", () => {
  it("for a dispatch section the tick cannot read", async () => {
    const w = world();
    try {
      const yaml = `${TRACKER}dispatch:\n  states: [in_progress]\n`;
      w.setConfig(yaml);
      const refused = (await tickOf(w)).refused;
      expect(refused).toStartWith(
        "the dispatch section on the default branch cannot be read",
      );
      checkout(w, { ".config/jig.yaml": yaml });
      expect(await failedCheck(w)).toContain(`dispatch: ${refused}`);
    } finally {
      w.close();
    }
  });

  it("for issue facets the tick's tracker cannot open", async () => {
    const w = world();
    try {
      // One label for two facets: the section reads, the facets do not resolve, and the turn stops.
      const yaml = `${TRACKER}  facets:\n    type: {store: label, labels: {bug: shared}}\n    priority: {store: label, labels: {high: shared}}\n`;
      w.setConfig(yaml);
      const refused = (await tickOf(w)).refused ?? "";
      const reason = refused.split("thrown in the plan phase: ")[1];
      expect(reason).toContain("one label would set two facts");
      checkout(w, { ".config/jig.yaml": yaml });
      expect(await failedCheck(w)).toContain(
        `tracker: the issue service cannot be opened: ${reason}`,
      );
    } finally {
      w.close();
    }
  });

  it("for a change-area catalog the default branch does not hold", async () => {
    const w = world();
    try {
      const yaml = `${TRACKER}drive:\n  change_areas_catalog: ${CATALOG}\n`;
      w.setConfig(yaml);
      const detail = failedDetail(
        await tickOf(w),
        "the change-area catalog cannot be read",
      );
      expect(detail).toContain(`names ${CATALOG}`);
      checkout(w, { ".config/jig.yaml": yaml });
      expect(await failedCheck(w)).toContain(`catalog: ${detail}`);
    } finally {
      w.close();
    }
  });

  it("for a change-area catalog that is not valid, naming the file where the tick names the branch", async () => {
    const w = world();
    try {
      const yaml = `${TRACKER}drive:\n  change_areas_catalog: ${CATALOG}\n`;
      const catalog = "areas:\n  docs:\n    paths: docs/**\n";
      w.setConfig(yaml);
      w.setRepoFile(CATALOG, catalog);
      const detail = failedDetail(
        await tickOf(w),
        "the change-area catalog cannot be read",
      );
      expect(detail).toContain(`${SLUG}@main:${CATALOG} is not valid`);
      checkout(w, { ".config/jig.yaml": yaml, [CATALOG]: catalog });
      expect(await failedCheck(w)).toContain(
        `catalog: ${detail.replace(`${SLUG}@main:`, "")}`,
      );
    } finally {
      w.close();
    }
  });

  it("and passes a configuration the tick reads whole", async () => {
    const w = world();
    try {
      const yaml = `${TRACKER}drive:\n  change_areas_catalog: ${CATALOG}\n`;
      const catalog = "areas:\n  docs:\n    paths: [docs/**]\n";
      w.setConfig(yaml);
      w.setRepoFile(CATALOG, catalog);
      const repo = await tickOf(w, 0);
      expect(repo.refused).toBeNull();
      expect(repo.records.filter((r) => !r.ok)).toEqual([]);
      checkout(w, { ".config/jig.yaml": yaml, [CATALOG]: catalog });
      const run = await w.dispatch(["check"]);
      expectSpawnExit(run, 0);
      expect(run.stdout).toContain("the tick reads the configuration");
    } finally {
      w.close();
    }
  });
});

describe("checkConfiguration", () => {
  const roots: string[] = [];
  const rootWith = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "config-check-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("reads a checkout with no configuration file as the tick reads a default branch with none", () => {
    expect(checkConfiguration(rootWith({}))).toEqual([]);
  });

  it("stops at a section that does not read, as the tick's turn does", () => {
    const findings = checkConfiguration(
      rootWith({
        ".config/jig.yaml": `issue_tracker:\n  adapter: nope\ndispatch: [1]\ndrive:\n  change_areas_catalog: missing.yaml\n`,
      }),
    );
    expect(findings).toEqual([
      {
        part: "dispatch",
        message:
          "the dispatch section on the default branch cannot be read, so nothing is planned: dispatch must be a mapping",
      },
    ]);
  });

  it("refuses a tracker the tick cannot open, and a catalog path outside the repository, together", () => {
    const findings = checkConfiguration(
      rootWith({
        ".config/jig.yaml": `issue_tracker:\n  adapter: nope\ndrive:\n  change_areas_catalog: ../catalog.yaml\n`,
      }),
    );
    expect(findings.map((f) => f.part)).toEqual(["tracker", "catalog"]);
    expect(findings[0]?.message).toBe(
      "the issue service cannot be opened: issue_tracker.adapter 'nope' is not supported (known: linear, github, jira)",
    );
    expect(findings[1]?.message).toContain(
      "drive.change_areas_catalog must be a repository-relative path",
    );
  });

  it("refuses a label taxonomy that fails its lint, which leaves type and size unreadable", () => {
    const findings = checkConfiguration(
      rootWith({
        ".config/jig.yaml": "issue_tracker:\n  adapter: github\n",
        "label-taxonomy.yaml": "groups: [unclosed\n",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.part).toBe("tracker");
    expect(findings[0]?.message).toContain("fails its lint");
  });

  it("refuses a size facet the label taxonomy has no group for", () => {
    const findings = checkConfiguration(
      rootWith({
        ".config/jig.yaml": `issue_tracker:\n  adapter: github\n  facets:\n    size: {store: label}\n`,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("has no size group");
  });
});
