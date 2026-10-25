/**
 * The command line, run as a consumer runs it: a spawned process whose
 * working directory is a scratch repository with its own configuration and
 * catalog. The eligibility mode reads no tracker, so these runs need no
 * tracker credential and no team.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { issue, relabel } from "./helpers.ts";

const script = join(import.meta.dir, "..", "scripts", "candidates.ts");
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = `review:
  repo_label: web
  taxonomy:
    repos: [web, api]
    types: [bug, feature]
    ownership_prefixes: ["team:"]
do_item:
  agents:
    codearea_areas: { "area:billing": billing }
drive:
  change_areas_catalog: .config/change-areas.yaml
work_batch:
  solo_flags: [privacy-review]
  sizes: [xs, small, medium, large]
`;

const CATALOG = `areas:
  billing:
    paths: ["src/billing/**"]
    tracker:
      labels: [area:billing]
  infra:
    paths: ["deploy/**"]
    tracker:
      labels: [area:infra]
      flags: [db-migration]
`;

function consumer(config = CONFIG, catalog: string | null = CATALOG): string {
  const dir = mkdtempSync(join(tmpdir(), "work-batch-cli-"));
  scratch.push(dir);
  mkdirSync(join(dir, ".config"));
  writeFileSync(join(dir, ".config", "jig.yaml"), config);
  if (catalog !== null)
    writeFileSync(join(dir, ".config", "change-areas.yaml"), catalog);
  return dir;
}

/** The child's environment: this repository's configuration and no tracker credential. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("JIG__") &&
      !k.startsWith("LINEAR_") &&
      !["JIG_OVERLAY", "JIG_CONSUMER_ROOT"].includes(k)
    )
      env[k] = v;
  return env;
}

function runCli(cwd: string, args: string[], stdin = "") {
  return Bun.spawnSync(["bun", script, ...args], {
    cwd,
    env: childEnv(),
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

const base = issue("ENG-0").labels;

describe("--eligibility", () => {
  it("prints the versioned verdicts and policy from the repository's configuration", () => {
    const dir = consumer();
    const issues = [
      issue("ENG-1"),
      issue("ENG-2", { labels: [...base, "privacy-review"] }),
      issue("ENG-3", { labels: [...base, "db-migration"] }),
      issue("ENG-4", { labels: relabel(base, ["small"], ["large"]) }),
    ];
    const run = runCli(dir, ["--eligibility"], JSON.stringify(issues));
    expectSpawnExit(run, 0, "eligibility");
    const report = JSON.parse(run.stdout.toString());
    expect(report.version).toBe(1);
    expect(report.policy.soloFlags).toEqual([
      "db-migration",
      "hitl",
      "manual-ops",
      "privacy-review",
    ]);
    expect(report.policy.sizes).toEqual(["xs", "small", "medium", "large"]);
    expect(
      report.verdicts.map((v: { identifier: string; eligible: boolean }) => [
        v.identifier,
        v.eligible,
      ]),
    ).toEqual([
      ["ENG-1", true],
      ["ENG-2", false],
      ["ENG-3", false],
      ["ENG-4", false],
    ]);
    expect(report.verdicts[3].reason).toEqual({
      kind: "not-batchable-size",
      size: "large",
    });
  });

  it("honours --claimed", () => {
    const dir = consumer();
    const mine = issue("ENG-1", { assignee: { id: "u", name: "Me" } });
    const run = runCli(
      dir,
      ["--eligibility", "--claimed", "ENG-1"],
      JSON.stringify([mine]),
    );
    expectSpawnExit(run, 0, "claimed");
    expect(JSON.parse(run.stdout.toString()).verdicts[0].eligible).toBe(true);
  });

  it("refuses input it cannot read as complete issues (exit 2)", () => {
    const dir = consumer();
    const { truncated: _, ...partial } = issue("ENG-1");
    for (const input of ["not json", "{}", JSON.stringify([partial])]) {
      const run = runCli(dir, ["--eligibility"], input);
      expectSpawnExit(run, 2, `input ${input.slice(0, 20)}`);
      expect(run.stderr.toString()).toContain("unreadable eligibility input");
      expect(run.stdout.toString()).toBe("");
    }
  });

  it("refuses an anchor beside it (exit 2)", () => {
    const run = runCli(consumer(), ["--eligibility", "billing"], "[]");
    expectSpawnExit(run, 2, "eligibility with an anchor");
  });

  it("fails on a configuration the skill cannot run on (exit 1)", () => {
    // `work_batch` is the last section, so this line lands in it.
    const broken = consumer(`${CONFIG}  size_points: { xs: 1 }\n`);
    const run = runCli(broken, ["--eligibility"], "[]");
    expectSpawnExit(run, 1, "size points that do not price every size");
    expect(run.stderr.toString()).toContain("work_batch.size_points");
    expect(run.stderr.toString()).toContain(join(".config", "jig.yaml"));
  });

  it("fails when the declared catalog cannot be read, rather than reading no flags (exit 1)", () => {
    const run = runCli(consumer(CONFIG, null), ["--eligibility"], "[]");
    expectSpawnExit(run, 1, "missing catalog");
    expect(run.stderr.toString()).toContain("could not be read");
  });
});

describe("the proposal's command line", () => {
  it("refuses a bad limit, budget or format before reading the tracker (exit 2)", () => {
    const dir = consumer();
    for (const args of [
      ["billing", "--limit", "0"],
      ["billing", "--budget", "x"],
      ["billing", "--format", "yaml"],
      ["billing", "--unknown"],
      [],
    ]) {
      const run = runCli(dir, args);
      expectSpawnExit(run, 2, args.join(" "));
    }
  });

  it("needs an adopted repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-batch-bare-"));
    scratch.push(dir);
    const run = runCli(dir, ["--eligibility"], "[]");
    expectSpawnExit(run, 1, "no configuration");
    expect(run.stderr.toString()).toContain("Jig configuration not found");
  });
});
