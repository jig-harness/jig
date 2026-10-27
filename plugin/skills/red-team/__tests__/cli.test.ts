/**
 * The CLI end to end, in scratch git repositories, spawned with the scratch
 * repository as its working directory; a fake agent command stands in for
 * `claude -p` in the fresh runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";

const CLI = join(import.meta.dir, "..", "scripts", "red-team.ts");
const FIXTURES = join(import.meta.dir, "fixtures");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "red-team-"));
  scratch.push(dir);
  return dir;
}

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG_")
    )
      env[key] = value;
  return { ...env, ...extra };
}

/** A git repository holding the fixtures under docs/, and `files`. */
function repository(files: Record<string, string> = {}): string {
  const root = temporary();
  const init = spawnSync("git", ["init", "-q", root], { env: cleanEnv() });
  expectSpawnExit(
    { exitCode: init.status, stdout: init.stdout, stderr: init.stderr },
    0,
    "git init",
  );
  mkdirSync(join(root, "docs"));
  for (const name of ["prd.md", "architecture.md"])
    writeFileSync(
      join(root, "docs", name),
      readFileSync(join(FIXTURES, name), "utf8"),
    );
  for (const [path, text] of Object.entries(files))
    writeFileSync(join(root, path), text);
  return root;
}

function cli(root: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: cleanEnv(extra),
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

interface PlanOutput {
  kind: string;
  kindFrom: string;
  directory: string;
  ignoredByGit: boolean | null;
  report: string;
  personas: { id: string; name: string; brief: string; prompt: string }[];
}

function plan(root: string, args: string[]): PlanOutput {
  const run = cli(root, ["plan", ...args]);
  expectSpawnExit(run, 0, "plan");
  return JSON.parse(run.stdout) as PlanOutput;
}

/** Findings a persona could write about the fixture PRD. */
function findings(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    persona: id,
    verdict: "revise",
    summary: `The view of ${id}.`,
    findings: [
      {
        severity: id === "security-auditor" ? "blocking" : "minor",
        passage: "The list feels instant.",
        risk: "Nobody can say when it is met.",
        question: "What response time counts as instant?",
      },
    ],
    ...extra,
  });
}

describe("plan", () => {
  test("a requirements document gets eight briefs in the default folder", () => {
    const root = repository();
    const out = plan(root, ["docs/prd.md"]);
    expect(out.kind).toBe("requirements");
    expect(out.kindFrom).toBe("frontmatter type: prd");
    expect(out.directory).toBe(join(root, ".context", "red-team", "docs-prd"));
    expect(out.ignoredByGit).toBe(false);
    expect(out.personas).toHaveLength(8);
    const brief = readFileSync(out.personas[4]?.brief ?? "", "utf8");
    expect(brief).toContain("# Red-team brief: Plain-language reader");
    expect(brief).toContain(join(root, "docs", "prd.md"));
    expect(brief).toContain("**A finding carries:**");
    expect(out.personas[4]?.prompt).toContain(out.personas[4]?.brief ?? "?");
  });

  test("an architecture document gets the four engineering personas, and its companion", () => {
    const root = repository({ ".gitignore": ".context/\n" });
    const out = plan(root, [
      "docs/architecture.md",
      "--companion",
      "docs/prd.md",
    ]);
    expect(out.personas.map((p) => p.id)).toEqual([
      "critical-cto",
      "security-auditor",
      "performance-engineer",
      "cost-optimizer",
    ]);
    expect(out.ignoredByGit).toBe(true);
    expect(readFileSync(out.personas[0]?.brief ?? "", "utf8")).toContain(
      "Its companion, for context only",
    );
  });

  test("a document of no detectable kind needs --kind", () => {
    const root = repository({ "notes.md": "# Notes\n\n## Requirements\n" });
    const refused = cli(root, ["plan", "notes.md"]);
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("pass --kind requirements");
    const out = plan(root, [
      "notes.md",
      "--kind",
      "architecture",
      "--out",
      "review",
    ]);
    expect(out.kindFrom).toBe("--kind");
    expect(out.directory).toBe(join(root, "review"));
    expectSpawnExit(cli(root, ["plan", "notes.md", "--kind", "design"]), 2);
  });
});

describe("collect and report", () => {
  test("collects every persona, then writes one report", () => {
    const root = repository();
    const out = plan(root, ["docs/architecture.md"]);
    const missing = cli(root, ["report", out.directory]);
    expectSpawnExit(missing, 1, "report before collecting");
    expect(missing.stderr).toContain("critical-cto, security-auditor");
    for (const persona of out.personas) {
      const passage = "anyone with the invitation link joins the list.";
      const body = findings(persona.id).replace(
        "The list feels instant.",
        passage,
      );
      if (persona.id === "cost-optimizer")
        writeFileSync(
          join(out.directory, `${persona.id}.reply.md`),
          `My review.\n\n\`\`\`json\n${body}\n\`\`\`\n`,
        );
      else writeFileSync(join(out.directory, `${persona.id}.json`), body);
      const context =
        persona.id === "cost-optimizer" ? "same-session" : "subagent";
      expectSpawnExit(
        cli(root, ["collect", out.directory, persona.id, "--context", context]),
        0,
        persona.id,
      );
    }
    const report = cli(root, ["report", out.directory]);
    expectSpawnExit(report, 0, "report");
    const text = readFileSync(out.report, "utf8");
    expect(text).toStartWith("# Red-team review: Shared lists — architecture");
    expect(text).toContain(
      "| Security auditor | revise | 1 | 0 | 0 | subagent |",
    );
    expect(text).toContain(
      "| Cost optimizer | revise | 0 | 0 | 1 | this session |",
    );
    expect(text).toContain("### F1. Blocking, from the security auditor");
    expect(text).toContain("> anyone with the invitation link joins the list.");
    expect(text).toContain(
      "- **Question:** What response time counts as instant?",
    );
    expect(text).toContain("**Not in fresh context:** 1 of 4 personas");
    expect(text).toMatch(
      /`reviewed: "red-team by persona \(critical-cto, security-auditor, performance-engineer, cost-optimizer\), \d{4}-\d{2}-\d{2}, <link>"`/,
    );
  });

  test("a misquoted passage is sent back, not collected", () => {
    const root = repository();
    const out = plan(root, ["docs/prd.md"]);
    writeFileSync(
      join(out.directory, "scope-cutter.json"),
      findings("scope-cutter").replace("feels instant", "loads in 100 ms"),
    );
    const run = cli(root, [
      "collect",
      out.directory,
      "scope-cutter",
      "--context",
      "subagent",
    ]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain(
      "finding 1: the passage is not in the document",
    );
    expect(existsSync(join(out.directory, "scope-cutter.findings.json"))).toBe(
      false,
    );
    expectSpawnExit(
      cli(root, ["collect", out.directory, "nobody", "--context", "subagent"]),
      2,
    );
  });

  test("a document changed during the review stops it", () => {
    const root = repository();
    const out = plan(root, ["docs/prd.md"]);
    writeFileSync(
      join(out.directory, "day-walker.json"),
      findings("day-walker"),
    );
    writeFileSync(
      join(root, "docs", "prd.md"),
      `${readFileSync(join(root, "docs", "prd.md"), "utf8")}\nOne more line.\n`,
    );
    const run = cli(root, [
      "collect",
      out.directory,
      "day-walker",
      "--context",
      "subagent",
    ]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain("the document changed since the plan");
  });
});

const FAKE_AGENT = `#!/usr/bin/env bun
const prompt = process.argv[process.argv.length - 1] ?? "";
const brief = /brief at (.+) and follow it/.exec(prompt)?.[1] ?? "";
const text = await Bun.file(brief).text();
const id = /"persona": "([a-z-]+)"/.exec(text)?.[1];
const output = /and nothing else, to \`([^\`]+)\`/.exec(text)?.[1] ?? "";
const mode = process.env.FAKE_AGENT_MODE ?? "print";
if (mode === "fail" && id === "cost-optimizer") {
  console.error("out of credits");
  process.exit(3);
}
const body = {
  persona: id,
  verdict: "revise",
  summary: "CLAUDECODE=" + (process.env.CLAUDECODE ?? "unset"),
  findings: [
    { severity: "major", passage: "## Scale and cost", risk: "r", question: "q?" },
  ],
};
if (mode === "write") await Bun.write(output, JSON.stringify(body));
else console.log("Findings follow.\\n\`\`\`json\\n" + JSON.stringify(body, null, 2) + "\\n\`\`\`");
`;

describe("fresh", () => {
  const agentDir = temporary();
  const agent = writeFakeProgram(join(agentDir, "fake-agent"), FAKE_AGENT);

  for (const mode of ["print", "write"])
    test(`runs each persona as a new process and collects what it ${mode === "print" ? "printed" : "wrote"}`, () => {
      const root = repository();
      const out = plan(root, ["docs/architecture.md"]);
      const run = cli(root, ["fresh", out.directory, "--", agent], {
        FAKE_AGENT_MODE: mode,
        CLAUDECODE: "1",
      });
      expectSpawnExit(run, 0, "fresh");
      for (const persona of out.personas) {
        const kept = JSON.parse(
          readFileSync(
            join(out.directory, `${persona.id}.findings.json`),
            "utf8",
          ),
        ) as { context: string; summary: string };
        expect(kept.context).toBe("fresh-run");
        expect(kept.summary).toBe("CLAUDECODE=unset");
      }
      expectSpawnExit(cli(root, ["report", out.directory]), 0, "report");
    });

  test("names a persona whose run failed, and a second run repeats only it", () => {
    const root = repository();
    const out = plan(root, ["docs/architecture.md"]);
    const failed = cli(root, ["fresh", out.directory, "--", agent], {
      FAKE_AGENT_MODE: "fail",
    });
    expectSpawnExit(failed, 1, "fresh with a failing persona");
    expect(failed.stderr).toContain("cost-optimizer: exited 3: out of credits");
    expect(failed.stdout).toContain("critical-cto: collected");
    const again = cli(root, ["fresh", out.directory, "--", agent]);
    expectSpawnExit(again, 0, "fresh again");
    expect(again.stdout.trim()).toBe("cost-optimizer: collected");
  });

  test("needs an agent command", () => {
    const root = repository();
    const out = plan(root, ["docs/architecture.md"]);
    expectSpawnExit(cli(root, ["fresh", out.directory]), 2);
  });
});
