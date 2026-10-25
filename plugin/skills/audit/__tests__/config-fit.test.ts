import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { load } from "../../../shared/yaml.ts";
import {
  commandProblems,
  commandSegments,
  NOTHING_TO_SUGGEST,
} from "../scripts/config-fit.ts";
import { checkConfig, loadSchema } from "../scripts/lib/schema.ts";
import {
  cleanEnv,
  fakeGh,
  runScript,
  scratchRepo,
  withPath,
} from "./helpers.ts";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const r = scratchRepo(files);
  repos.push(r);
  return r;
};

interface Report {
  configured: boolean;
  forge: string;
  facts: Record<string, string>;
  findings: { id: string; severity: string; message: string }[];
  declined: { finding: { id: string } }[];
  suggestions: {
    field: string;
    key?: string;
    value: unknown;
    evidence: string;
  }[];
  draft?: string;
}

function fit(
  files: Record<string, string>,
  args: string[] = ["--offline"],
  env?: Record<string, string>,
): { code: number; report: Report; dir: string } {
  const dir = repo(files);
  const run = runScript("config-fit.ts", [...args, "--json"], dir, env);
  if (run.code === 2) throw new Error(run.err);
  return { code: run.code, report: JSON.parse(run.out) as Report, dir };
}

/** Run git in a scratch repository, failing the test when it fails. */
function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: cleanEnv(),
    encoding: "utf8",
  });
  expectSpawnExit(
    { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
    0,
  );
  return r.stdout.trim();
}

/** Commit an empty change with `subject` to the scratch repository. */
function commit(dir: string, subject: string): void {
  git(dir, "commit", "-q", "--allow-empty", "-m", subject);
}

/**
 * Give a scratch repository an origin remote that is never contacted, its
 * remote-tracking branches (each at HEAD unless a commit is given) and an
 * origin/HEAD naming `head`.
 */
function withOrigin(
  dir: string,
  branches: Record<string, string | null>,
  head?: string,
): void {
  git(dir, "remote", "add", "origin", "https://example.invalid/web.git");
  for (const [name, at] of Object.entries(branches))
    git(dir, "update-ref", `refs/remotes/origin/${name}`, at ?? "HEAD");
  if (head !== undefined)
    git(
      dir,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${head}`,
    );
}

/** Run config-fit with `--json` in an existing repository. */
function fitIn(dir: string, args: string[], env = cleanEnv()): Report {
  const run = runScript("config-fit.ts", [...args, "--json"], dir, env);
  if (run.code === 2) throw new Error(run.err);
  return JSON.parse(run.out) as Report;
}

const ids = (r: Report, severity?: string) =>
  r.findings
    .filter((f) => !severity || f.severity === severity)
    .map((f) => f.id);

describe("command lines", () => {
  test("split on operators outside quotes", () => {
    expect(
      commandSegments(`FOO=1 bun run a && echo "x && y" | wc; make b`),
    ).toEqual([
      ["FOO=1", "bun", "run", "a"],
      ["echo", "x && y"],
      ["wc"],
      ["make", "b"],
    ]);
  });
  test("a placeholder, a missing script, file or make target is an error", () => {
    const dir = repo({
      "package.json": '{"scripts":{"gates":"true"}}',
      Makefile: "check:\n\ttrue\n",
      "tools/run.ts": "",
    });
    expect(commandProblems("<your plan command>", dir)[0]?.message).toContain(
      "placeholder",
    );
    expect(commandProblems("bun run gates", dir)).toEqual([]);
    expect(commandProblems("bun run missing", dir)[0]?.message).toContain(
      'no "missing" script',
    );
    expect(commandProblems("bun tools/run.ts --x", dir)).toEqual([]);
    expect(commandProblems("bun tools/nope.ts", dir)[0]?.message).toContain(
      "does not exist",
    );
    expect(commandProblems("make check && make lint", dir)).toEqual([
      { severity: "error", message: 'Makefile has no "lint" target' },
    ]);
    expect(commandProblems("./scripts/gates.sh", dir)[0]?.severity).toBe(
      "error",
    );
    expect(commandProblems("no-such-program-xyz --all", dir)[0]).toEqual({
      severity: "warning",
      message: "no-such-program-xyz is not installed on this machine",
    });
    // A flag's value is not a script or target; another folder's targets are reported unchecked.
    for (const other of [
      "bun run --filter '*' gates",
      "npm run -w web build",
      "make -C sub check",
    ])
      expect(commandProblems(other, dir).map((p) => p.severity)).toEqual([
        "info",
      ]);
    expect(commandProblems("make -j 4 check", dir)).toEqual([]);
  });

  test("every make target, bare runner scripts and exec are checked", () => {
    const dir = repo({
      "package.json": '{"scripts":{"gates":"true"}}',
      Makefile: "check:\n\ttrue\n",
    });
    expect(commandProblems("make check missing", dir)).toEqual([
      { severity: "error", message: 'Makefile has no "missing" target' },
    ]);
    expect(commandProblems("make V=1 check", dir)).toEqual([]);
    for (const runner of ["yarn", "pnpm", "bun"]) {
      expect(
        commandProblems(`${runner} gates`, dir).every((p) =>
          p.message.endsWith("is not installed on this machine"),
        ),
      ).toBe(true);
      expect(
        commandProblems(`${runner} missing`, dir).some((p) =>
          p.message.includes('"missing" is neither'),
        ),
      ).toBe(true);
    }
    expect(commandProblems("bun test", dir)).toEqual([]);
    expect(commandProblems("npm test", dir)[0]?.message).toContain(
      'no "test" script',
    );
    expect(commandProblems("exec ./missing.sh", dir)[0]?.message).toContain(
      "does not exist",
    );
  });

  test("a command line a shell refuses is an error, and what follows cd is unchecked", () => {
    const dir = repo({ "package.json": '{"scripts":{}}' });
    for (const bad of [
      "&&",
      "bun run gates &&",
      "echo 'open",
      "&& true",
      'echo "unterminated $HOME',
      "bun src/*.ts &&",
      "echo $HOME $? &&",
      "echo $ &&",
      "bun src/*.ts '${' &&",
      "echo '$(' '`' '\\' &&",
      'echo "$" "$\'" &&',
      'echo $"b" &&',
      "echo 'a\nb' &&",
    ])
      expect(commandProblems(bad, dir)[0]?.severity).toBe("error");
    expect(commandProblems("true; ", dir)).toEqual([]);
    expect(commandProblems("cd web && bun run gates", dir)).toEqual([
      {
        severity: "info",
        message:
          "changes directory (cd web), so what runs after it is unchecked",
      },
    ]);
  });

  test("shell syntax beyond words, quotes and separators is unchecked, not guessed at", () => {
    const dir = repo({ "package.json": '{"scripts":{}}' });
    for (const line of [
      "true\nbun run missing",
      'printf "a\\"b"',
      "bun run missing # note",
      "true & bun run missing",
      "bun run missing > out.txt",
      "bun $(echo x)",
      'echo "$HOME" && bun run missing',
      "(bun run missing)",
      "bun src/*.ts",
      "bun tools/[ab].ts",
      "bun ~/gate.ts",
      "! bun run missing",
      "bun run missing # it's",
      'echo \\" && bun run missing',
      "bun $(echo ')')",
      "bun `echo '`'`",
      `echo $\{MESSAGE:-a;|b}`,
      `echo $\{MESSAGE:-a || || b}`,
      `echo "$\{MESSAGE:-" ;| "}"`,
      "echo $((1 || || 2))",
      'echo $"a ;| b"',
      "echo $[1 || || 2]",
      "echo $'it\\'s ;|'",
      'echo "$(echo "a ;| b")"',
    ])
      expect(commandProblems(line, dir).map((p) => p.severity)).toEqual([
        "info",
      ]);
    for (const line of ["env -i bun run missing", "exec -a gate bun run x"])
      expect(commandProblems(line, dir)).toEqual([
        {
          severity: "info",
          message: `runs its command through \`${line.split(" ").slice(0, 2).join(" ")}\`, so that command is unchecked`,
        },
      ]);
    expect(
      commandProblems("env FOO=1 bun run missing", dir)[0]?.message,
    ).toContain('no "missing" script');
  });

  test("an explicit run names a package script before a file", () => {
    const dir = repo({
      "package.json": '{"scripts":{"lint.js":"true","check/all":"true"}}',
    });
    for (const runner of ["npm", "pnpm", "yarn", "bun"])
      for (const script of ["lint.js", "check/all"])
        expect(
          commandProblems(`${runner} run ${script}`, dir).filter(
            (p) => p.severity === "error",
          ),
        ).toEqual([]);
    expect(commandProblems("npm run other.js", dir)[0]?.message).toContain(
      'no "other.js" script',
    );
    expect(commandProblems("bun run other.js", dir)[0]?.message).toContain(
      "does not exist",
    );
  });

  test("a program path must be a tracked, executable file", () => {
    const dir = repo({ "scripts/gate.sh": "#!/bin/sh\n", "tools/x.ts": "" });
    expect(commandProblems("./scripts", dir)[0]?.message).toContain(
      "is not a file",
    );
    if (process.platform !== "win32")
      expect(commandProblems("./scripts/gate.sh", dir)[0]?.message).toContain(
        "is not executable",
      );
    chmodSync(join(dir, "scripts/gate.sh"), 0o755);
    expect(commandProblems("./scripts/gate.sh", dir)).toEqual([]);
    writeFileSync(join(dir, "scripts/new.sh"), "");
    chmodSync(join(dir, "scripts/new.sh"), 0o755);
    expect(commandProblems("./scripts/new.sh", dir)[0]).toEqual({
      severity: "warning",
      message: "./scripts/new.sh is not tracked, so a fresh clone lacks it",
    });
  });

  test("make targets on one rule line, and targets an include may hold", () => {
    const multi = repo({ Makefile: "lint test: deps\n\ttrue\nVAR := x\n" });
    expect(commandProblems("make test && make lint", multi)).toEqual([]);
    expect(commandProblems("make VAR", multi)[0]?.severity).toBe("error");
    const included = repo({ Makefile: "include rules.mk\n" });
    expect(commandProblems("make check", included)[0]?.severity).toBe(
      "warning",
    );
  });
});

describe("the configuration file", () => {
  test("no file is reported, and the repository's shape suggests a gate command", () => {
    const { code, report } = fit({
      "package.json": '{"scripts":{"check":"tsc"}}',
      "bun.lock": "",
    });
    expect(code).toBe(0);
    expect(report.configured).toBe(false);
    expect(ids(report)).toContain("missing-file");
    const gate = report.findings.find(
      (f) => f.id === "suggestion:gates.command",
    );
    expect(gate?.message).toContain("bun run check");
  });

  test("a gate script CI runs is the suggested gate command, ahead of a package script", () => {
    const dir = repo({
      "package.json": '{"scripts":{"test":"true"}}',
      "scripts/gates.sh": "#!/bin/sh\ntrue\n",
      "bin/check": "#!/bin/sh\ntrue\n",
      ".github/workflows/ci.yml":
        "on: pull_request\njobs:\n  gates:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./scripts/gates.sh --all\n",
    });
    chmodSync(join(dir, "scripts/gates.sh"), 0o755);
    chmodSync(join(dir, "bin/check"), 0o755);
    const gate = fitIn(dir, ["--offline"]).suggestions.find(
      (s) => s.field === "gates.command",
    );
    // The arguments CI passes it are kept: the script's default may run less.
    expect(gate).toMatchObject({
      value: "./scripts/gates.sh --all",
      evidence:
        "scripts/gates.sh is an executable script named like the repository's check, and CI runs it (.github/workflows/ci.yml)",
    });
    // Without a package script or CI step, a gate script CI does not run is still found.
    const alone = repo({ "scripts/check.sh": "#!/bin/sh\ntrue\n" });
    expect(
      fitIn(alone, ["--offline"]).suggestions.find(
        (s) => s.field === "gates.command",
      )?.value,
    ).toBe("bash scripts/check.sh");
  });

  test("a gate script CI only mentions, or runs with arguments that cannot be kept, is suggested as such", () => {
    const suggestion = (run: string) => {
      const dir = repo({
        "package.json": '{"scripts":{"test":"true"}}',
        "scripts/gates.sh": "#!/bin/sh\ntrue\n",
        ".github/workflows/ci.yml": `on: pull_request\njobs:\n  gates:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
      });
      chmodSync(join(dir, "scripts/gates.sh"), 0o755);
      return fitIn(dir, ["--offline"]).suggestions.find(
        (s) => s.field === "gates.command",
      );
    };
    // A mention in an argument or a comment runs nothing: the package script wins.
    for (const run of [
      "echo ./scripts/gates.sh",
      "echo ready # ./scripts/gates.sh",
      "echo ready # && ./scripts/gates.sh --all",
    ])
      expect(suggestion(run)?.value).toBe("npm run test");
    // The interpreter CI names is kept: the shebang may not be the shell the script needs.
    expect(suggestion("make lint && bash scripts/gates.sh")?.value).toBe(
      "bash scripts/gates.sh",
    );
    expect(suggestion("sh scripts/gates.sh --all")?.value).toBe(
      "sh scripts/gates.sh --all",
    );
    expect(suggestion("./scripts/gates.sh --all # every suite")?.value).toBe(
      "./scripts/gates.sh --all",
    );
    // What CI sets or passes that a configuration value cannot repeat leaves the command unsettled.
    const unsettled: [string, string][] = [
      [
        "./scripts/gates.sh --only $SUITE",
        "`./scripts/gates.sh --only $SUITE`",
      ],
      [
        "CHECK_SCOPE=all ./scripts/gates.sh",
        "`CHECK_SCOPE=all ./scripts/gates.sh`",
      ],
      [
        "env CHECK_SCOPE=all ./scripts/gates.sh",
        "`env CHECK_SCOPE=all ./scripts/gates.sh`",
      ],
      [
        "./scripts/gates.sh --lint && ./scripts/gates.sh --test",
        "`./scripts/gates.sh --lint`, `./scripts/gates.sh --test`",
      ],
    ];
    for (const [run, as] of unsettled)
      expect(suggestion(run)).toMatchObject({
        value: "./scripts/gates.sh",
        evidence: expect.stringContaining(`; CI runs it as ${as}`),
        message: expect.stringContaining(
          "./scripts/gates.sh alone may run less",
        ),
      });
    // A block whose lines are not each a command run at the root shows no run:
    // a here-document's lines are input, and a `cd` moves what follows it.
    // Both are recognised by text in any form, so a mere mention counts too.
    for (const run of [
      "cat <<'EOF'\n./scripts/gates.sh --all\nEOF",
      "cat <<''\n./scripts/gates.sh --all\n\n",
      "cat <<\\EOF\n./scripts/gates.sh --all\nEOF",
      "cd tools && ./scripts/gates.sh --all",
      "cd tools\n./scripts/gates.sh --all",
      "command cd tools\n./scripts/gates.sh --all",
      "CHECK_SCOPE=all cd tools && ./scripts/gates.sh --all",
      "echo 'usage: <<EOF'\n./scripts/gates.sh --all",
      "c'd' tools\n./scripts/gates.sh --all",
      'c""d tools\n./scripts/gates.sh --all',
      "c\\d tools\n./scripts/gates.sh --all",
      "pu'sh'd tools\n./scripts/gates.sh --all",
    ])
      expect(suggestion(run)?.value).toBe("npm run test");
  });

  test("an environment the workflow, job or step sets leaves a CI-run gate script unsettled", () => {
    const suggestion = (workflow: string) => {
      const dir = repo({
        "package.json": '{"scripts":{"test":"true"}}',
        "scripts/gates.sh": "#!/bin/sh\ntrue\n",
        ".github/workflows/ci.yml": workflow,
      });
      chmodSync(join(dir, "scripts/gates.sh"), 0o755);
      return fitIn(dir, ["--offline"]).suggestions.find(
        (s) => s.field === "gates.command",
      );
    };
    const step = "      - run: ./scripts/gates.sh --all\n";
    for (const workflow of [
      `on: pull_request\nenv:\n  CHECK_SCOPE: all\njobs:\n  gates:\n    runs-on: ubuntu-latest\n    steps:\n${step}`,
      `on: pull_request\njobs:\n  gates:\n    runs-on: ubuntu-latest\n    env:\n      CHECK_SCOPE: all\n    steps:\n${step}`,
      `on: pull_request\njobs:\n  gates:\n    runs-on: ubuntu-latest\n    steps:\n${step}        env:\n          CHECK_SCOPE: all\n`,
    ])
      expect(suggestion(workflow)).toMatchObject({
        value: "./scripts/gates.sh",
        evidence: expect.stringContaining(
          "; CI runs it as `./scripts/gates.sh --all` with CHECK_SCOPE set",
        ),
      });
  });

  test("unknown, refused, mistyped and deprecated fields", () => {
    const { code, report } = fit({
      ".config/jig.yaml": `gates:
  comand: bun run gates
pull_requests:
  stacking: sideways
  colour: blue
review:
  bots: reviewer
  taxonomy:
    provenance_label: pr-followup
do_issue:
  agents: {}
issue_tracker:
  states: { doing: Doing }
other_tool:
  anything: true
`,
    });
    expect(code).toBe(1);
    const all = ids(report);
    expect(all).toContain("unknown:gates.comand");
    expect(
      report.findings.find((f) => f.id === "unknown:gates.comand")?.message,
    ).toContain("Did you mean command?");
    expect(
      report.findings.find((f) => f.id === "unknown:pull_requests.colour")
        ?.severity,
    ).toBe("error");
    expect(
      report.findings.find((f) => f.id === "unknown:other_tool")?.severity,
    ).toBe("warning");
    expect(all).toContain("type:pull_requests.stacking");
    expect(all).toContain("type:review.bots");
    expect(all).toContain("type:issue_tracker.states");
    expect(all).toContain("refused:do_issue");
    expect(all).toContain("deprecated:review.taxonomy.provenance_label");
    // The skills' own validation refuses the same file.
    expect(all).toContain("rejected:do-item (pull-request policy)");
    expect(all).toContain("rejected:do-item (tracker)");
  });

  test("resolve-conflicts validates obligation text, optional commands and unknown keys", () => {
    const refused = (obligations: string) =>
      ids(
        fit({
          ".config/jig.yaml": `resolve_conflicts:\n  obligations: ${obligations}\n`,
        }).report,
      ).includes("rejected:resolve-conflicts");
    for (const value of [
      "null",
      "{}",
      "[{}]",
      '[{check: ""}]',
      "[{check: Inspect, command: 5}]",
      "[{check: Inspect, extra: unknown}]",
    ])
      expect(refused(value)).toBe(true);
    expect(refused("[{check: Inspect}]")).toBe(false);
    expect(refused("[{check: Inspect, command: bun run gates}]")).toBe(false);
  });

  test("the reflect skill's own validation refuses what it would refuse", () => {
    const refused = (reflection: string) =>
      ids(
        fit({ ".config/jig.yaml": `reflection:\n${reflection}` }).report,
      ).includes("rejected:reflect");
    expect(refused("  store: command\n")).toBe(true);
    expect(refused("  store: command\n  command: 5\n")).toBe(true);
    expect(refused("  store: command\n  command: [run, 5]\n")).toBe(true);
    expect(refused("  timeout_sec: 1000000\n")).toBe(true);
    // A journal git would track.
    expect(refused("  journal: notes/journal.jsonl\n")).toBe(true);
    expect(refused("  store: command\n  command: my-store --flag\n")).toBe(
      false,
    );
  });

  test("decide's sheet-repository validation refuses what it would refuse", () => {
    const refused = (repositories: string) =>
      ids(
        fit({
          ".config/jig.yaml": `sheets:\n  repositories: ${repositories}\n`,
        }).report,
      ).includes("rejected:decide, explain (sheets)");
    expect(refused("{ Beta: ../beta }")).toBe(true);
    expect(refused("{ 2beta: ../beta }")).toBe(true);
    expect(refused('{ beta: "" }')).toBe(true);
    expect(refused("{ beta: ../beta, gamma-2: /src/gamma }")).toBe(false);
  });

  test("drive-pr's severity-format validation refuses what it would refuse", () => {
    const refused = (formats: string) =>
      ids(
        fit({
          ".config/jig.yaml": `review:\n  severity_formats:\n${formats}`,
        }).report,
      ).includes("rejected:drive-pr (severity formats)");
    const entry = (shape: string, severities: string) =>
      `    - login: example-reviewer\n      shape: ${shape}\n      severities: ${severities}\n`;
    expect(refused(entry("regex", "{ Sev1: high }"))).toBe(true);
    expect(refused(entry("badge", "{ Sev1: critical }"))).toBe(true);
    expect(refused(entry("badge", "{}"))).toBe(true);
    expect(refused(entry("badge", "{ Sev1: high, SEV1: low }"))).toBe(true);
    expect(refused(entry("badge", '{ "Sev-1": high }'))).toBe(true);
    expect(refused(entry("badge", "{ Sev1: high, Sev2: medium }"))).toBe(false);
  });

  test("the handback landing check's own validation refuses what it would refuse", () => {
    const refused = (handback: string) =>
      ids(
        fit({
          ".config/jig.yaml": `design_brief:\n  handback:\n${handback}`,
        }).report,
      ).includes("rejected:design-brief-builder (handback)");
    const rest =
      "    rubric: rubric.md\n    scorecard: scorecard.md\n    browser_executable: /usr/bin/chromium\n";
    expect(refused(`    widths: [0]\n${rest}`)).toBe(true);
    expect(refused(`    widths: [-1]\n${rest}`)).toBe(true);
    expect(refused(`    widths: [390, 390]\n${rest}`)).toBe(true);
    expect(refused("    widths: [390]\n")).toBe(true);
    expect(refused(`    widths: [390, 1280]\n${rest}`)).toBe(false);
  });

  test("the code-stats skill's own validation refuses what it would refuse", () => {
    const refused = (codeStats: string) =>
      ids(
        fit({ ".config/jig.yaml": `code_stats:\n${codeStats}` }).report,
      ).includes("rejected:code-stats");
    expect(refused("  areas: [{}]\n")).toBe(true);
    expect(
      refused(
        "  areas:\n    - { name: web, paths: [a/**] }\n    - { name: web, paths: [b/**] }\n",
      ),
    ).toBe(true);
    expect(refused('  areas:\n    - { name: web, paths: ["a/[**"] }\n')).toBe(
      true,
    );
    expect(refused("  kinds: { test: [] }\n")).toBe(true);
    expect(refused("  areas:\n    - { name: web, paths: [web/**] }\n")).toBe(
      false,
    );
  });

  test("the changelog skill's own validation refuses what it would refuse", () => {
    const refused = (changelog: string, files: Record<string, string> = {}) =>
      ids(
        fit({
          ".config/jig.yaml": `changelog:\n  file: CHANGELOG.md\n${changelog}`,
          "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
          ...files,
        }).report,
      ).includes("rejected:changelog");
    expect(refused("  version: { tags: false }\n")).toBe(true);
    expect(refused("  version: { files: [] }\n")).toBe(true);
    expect(
      refused("  unreleased: write\n  release: { push: pull-request }\n"),
    ).toBe(true);
    expect(refused("  version: { tags: true }\n")).toBe(false);
  });

  test("the changelog section is resolved against the repository, as the skill's commands resolve it", () => {
    const refused = (changelog: string, files: Record<string, string>) =>
      ids(
        fit({
          ".config/jig.yaml": `changelog:\n  file: CHANGELOG.md\n${changelog}`,
          ...files,
        }).report,
      ).includes("rejected:changelog");
    const changelog = { "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n" };
    const files = (...paths: string[]) =>
      `  version:\n    files:\n${paths.map((p) => `      - { path: ${p}, key: version }\n`).join("")}`;
    // The changelog itself, and a format it says.
    expect(refused("  version: { tags: true }\n", {})).toBe(true);
    expect(
      refused("  version: { tags: true }\n", { "CHANGELOG.md": "# Notes\n" }),
    ).toBe(true);
    // A version file that is missing, lacks the key, or disagrees.
    expect(refused(files("missing.json"), changelog)).toBe(true);
    expect(
      refused(files("a.json"), { ...changelog, "a.json": '{"name":"a"}\n' }),
    ).toBe(true);
    expect(
      refused(files("a.json", "b.json"), {
        ...changelog,
        "a.json": '{"version":"1.0.0"}\n',
        "b.json": '{"version":"1.1.0"}\n',
      }),
    ).toBe(true);
    // A version the release cannot move: not major.minor.patch, written
    // twice, or in a form it does not edit in place.
    expect(
      refused(files("a.json"), {
        ...changelog,
        "a.json": '{"version":"banana"}\n',
      }),
    ).toBe(true);
    expect(
      refused(files("a.json"), {
        ...changelog,
        "a.json": '{"version":"1.0.0","version":"1.0.0"}\n',
      }),
    ).toBe(true);
    expect(
      refused(
        "  version:\n    files:\n      - { path: a.toml, key: package.version }\n",
        { ...changelog, "a.toml": 'package = { version = "1.0.0" }\n' },
      ),
    ).toBe(true);
    // No version source set, and no manifest to derive one from.
    expect(refused("", changelog)).toBe(true);
    expect(
      refused(files("a.json", "b.json"), {
        ...changelog,
        "a.json": '{"version":"1.0.0"}\n',
        "b.json": '{"version":"1.0.0"}\n',
      }),
    ).toBe(false);
    expect(
      refused("", { ...changelog, "package.json": '{"version":"1.0.0"}\n' }),
    ).toBe(false);
  });

  test("rules across fields, and paths and commands that do not exist", () => {
    const { report } = fit({
      ".config/jig.yaml": `gates:
  command: bun run gates
ci:
  hold_label: ci:hold
review:
  repo_label: web
  taxonomy: { repos: [api], ownership_prefixes: ["team:"] }
adr:
  directory: docs/decisions
drive:
  change_areas_catalog: docs/areas.yaml
fix_ci:
  regenerate_commands: ["<your generate command>"]
`,
      "package.json": "{}",
    });
    const errors = ids(report, "error");
    expect(errors).toContain("rule:ci.hold_label");
    expect(errors).toContain("rule:review.repo_label");
    expect(errors).toContain("derivation:gates.command");
    expect(errors).toContain("derivation:adr.directory");
    expect(errors).toContain("derivation:fix_ci.regenerate_commands[0]");
    expect(ids(report, "warning")).toContain(
      "derivation:drive.change_areas_catalog",
    );
  });

  test("work_batch.size_points prices exactly the batchable sizes", () => {
    const findings = (yaml: string) =>
      fit({ ".config/jig.yaml": yaml }).report.findings.filter(
        (f) =>
          f.id === "rule:work_batch.size_points" ||
          f.id === "rejected:work-batch",
      );
    const sizes = `issue_tracker:
  labels:
    batch_sizes: [s, m]
`;
    // The defaults price xs, small and medium, the default batchable sizes.
    expect(findings("gates:\n  command: bun run gates\n")).toEqual([]);
    // Other sizes need their own points; a warning until the skill is set up.
    expect(findings(sizes)).toEqual([
      {
        id: "rule:work_batch.size_points",
        severity: "warning",
        message: expect.stringContaining("work_batch.size_points must be set"),
      },
    ]);
    expect(
      findings(`${sizes}work_batch:\n  size_points: { s: 1, m: 3, l: 9 }\n`),
    ).toEqual([
      {
        id: "rule:work_batch.size_points",
        severity: "error",
        message: expect.stringContaining("must price exactly"),
      },
    ]);
    expect(
      findings(`${sizes}work_batch:\n  size_points: { m: 3, s: 1 }\n`),
    ).toEqual([]);
    // The rest of the section is checked as the skill checks it.
    expect(
      findings(
        `${sizes}work_batch:\n  size_points: { m: 3, s: 1 }\n  sizes: [s, l]\n`,
      ).map((f) => f.id),
    ).toEqual(["rejected:work-batch"]);
  });

  test("a work_batch section without sizes is warned about", () => {
    const sizes = (yaml: string) =>
      fit({ ".config/jig.yaml": yaml }).report.findings.filter(
        (f) => f.id === "rule:work_batch.sizes",
      );
    expect(sizes("gates:\n  command: bun run gates\n")).toEqual([]);
    expect(sizes("work_batch:\n  max_items: 4\n")).toEqual([
      {
        id: "rule:work_batch.sizes",
        severity: "warning",
        message: expect.stringContaining("without work_batch.sizes"),
      },
    ]);
    expect(sizes("work_batch:\n  sizes:\n")).toEqual([
      expect.objectContaining({ id: "rule:work_batch.sizes" }),
    ]);
    expect(sizes("work_batch:\n  sizes: [xs, small, medium, large]\n")).toEqual(
      [],
    );
  });

  describe("labels against the label taxonomy", () => {
    const taxonomy = `version: 1
types:
  - id: feature
  - id: bug
statuses:
  - id: todo
flags:
  - id: epic
    scope: container
  - id: hitl
    scope: shipping-item
`;
    const labels = `issue_tracker:
  labels:
    epic: epic
    hitl: hitl
    manual_ops: ops-step
    bug: [bug, "type:bug", defect]
    extractable_tails: ["hitl:legal"]
review:
  taxonomy:
    types: [feature, chore]
`;
    const taxonomyIds = (r: Report) =>
      ids(r).filter((id) => /taxonomy/.test(id));

    test("no taxonomy, or one only under templates, checks nothing", () => {
      const { report } = fit({
        ".config/jig.yaml": labels,
        "templates/label-taxonomy.yaml": taxonomy,
      });
      expect(taxonomyIds(report)).toEqual([]);
    });

    test("a configured label the taxonomy lacks, and a differing type copy, warn", () => {
      const { report } = fit({
        ".config/jig.yaml": labels,
        "docs/label-taxonomy.yaml": taxonomy,
      });
      // epic, hitl, the facet hitl:legal and the group-prefixed type:bug are
      // defined; the defaulted followup label is not the repository's choice
      // and is not checked.
      expect(taxonomyIds(report).sort()).toEqual([
        "taxonomy:issue_tracker.labels.bug",
        "taxonomy:issue_tracker.labels.manual_ops",
        "taxonomy:review.taxonomy.types",
      ]);
      const message = (id: string) =>
        report.findings.find((f) => f.id === id)?.message ?? "";
      expect(message("taxonomy:issue_tracker.labels.bug")).toContain(
        "defect, which docs/label-taxonomy.yaml",
      );
      const types = message("taxonomy:review.taxonomy.types");
      expect(types).toContain("not in docs/label-taxonomy.yaml: chore");
      expect(types).toContain("missing from the configuration: bug");
    });

    test("two taxonomies, or one that cannot be parsed, leave the labels unchecked", () => {
      const two = fit({
        ".config/jig.yaml": labels,
        "label-taxonomy.yaml": taxonomy,
        "docs/label-taxonomy.yml": taxonomy,
      }).report;
      expect(two.findings.filter((f) => /taxonomy/.test(f.id))).toEqual([
        expect.objectContaining({
          id: "unchecked:label-taxonomy",
          severity: "info",
        }),
      ]);
      const broken = fit({
        ".config/jig.yaml": labels,
        "label-taxonomy.yaml": "types: [unclosed\n",
      }).report;
      expect(broken.findings.filter((f) => /taxonomy/.test(f.id))).toEqual([
        expect.objectContaining({
          id: "unchecked:label-taxonomy",
          severity: "warning",
        }),
      ]);
      for (const malformed of [
        "types: feature\nstatuses:\n  - id: todo\n",
        "types:\n  - id: [feature, bug]\n",
        "types:\n  - id: feature\nflags: false\n",
        "types:\n  - id: 1\n",
        "types:\n  - id: feature\nflags:\n  - id: true\n",
      ]) {
        const report = fit({
          ".config/jig.yaml": labels,
          "label-taxonomy.yaml": malformed,
        }).report;
        expect(report.findings.filter((f) => /taxonomy/.test(f.id))).toEqual([
          expect.objectContaining({ id: "unchecked:label-taxonomy" }),
        ]);
      }
    });

    test("an id is trimmed, as the taxonomy lint reads it", () => {
      const { report } = fit({
        ".config/jig.yaml":
          "issue_tracker:\n  labels:\n    bug: bug\nreview:\n  taxonomy:\n    types: [feature, bug]\n",
        "label-taxonomy.yaml": 'types:\n  - id: feature\n  - id: " bug "\n',
      });
      expect(taxonomyIds(report)).toEqual([]);
    });

    test("issue_tracker.taxonomy names the file checked, and group and category labels count as defined", () => {
      const grouped = `${taxonomy}groups:
  - id: size
    labels: [{id: small}, {id: medium}]
categories:
  - id: stakeholder
    prefix: "hitl:"
    labels: [{id: legal}]
  - id: pattern
    prefix: "pattern:"
    open: "^[a-z-]+$"
`;
      const config = `issue_tracker:
  taxonomy: docs/labels.yaml
  labels:
    epic: epic
    hitl: hitl
    bug: [bug]
    batch_sizes: [small, tiny]
    extractable_tails: ["hitl:legal", "pattern:flaky"]
`;
      const { report } = fit({
        ".config/jig.yaml": config,
        "docs/labels.yaml": grouped,
        "label-taxonomy.yaml": "types: [unclosed\n",
      });
      expect(taxonomyIds(report)).toEqual([
        "taxonomy:issue_tracker.labels.batch_sizes",
      ]);
      expect(
        report.findings.find(
          (f) => f.id === "taxonomy:issue_tracker.labels.batch_sizes",
        )?.message,
      ).toContain("names tiny, which docs/labels.yaml does not define");
    });

    test("batch_sizes must name group labels: a type or a category label is not a size", () => {
      const grouped = `${taxonomy}groups:
  - id: size
    labels: [{id: small}]
categories:
  - id: stakeholder
    prefix: "hitl:"
    labels: [{id: legal}]
`;
      const { report } = fit({
        ".config/jig.yaml": `issue_tracker:
  labels:
    batch_sizes: [small, bug, "hitl:legal"]
`,
        "label-taxonomy.yaml": grouped,
      });
      const finding = report.findings.find(
        (f) => f.id === "taxonomy:issue_tracker.labels.batch_sizes",
      );
      expect(finding?.message).toContain(
        "names bug, hitl:legal, which label-taxonomy.yaml does not define as a group label",
      );
    });

    test("a category-prefixed label counts only as a closed category's exact label or an open category's matching slug", () => {
      const categorised = `${taxonomy}categories:
  - id: stakeholder
    prefix: "hitl:"
    labels: [{id: legal}]
  - id: pattern
    prefix: "pattern:"
    open: "[a-z]+"
`;
      const tails = (list: string) =>
        `issue_tracker:\n  labels:\n    extractable_tails: ${list}\n`;
      const unknownTails = (list: string) => {
        const { report } = fit({
          ".config/jig.yaml": tails(list),
          "label-taxonomy.yaml": categorised,
        });
        return (
          report.findings.find(
            (f) => f.id === "taxonomy:issue_tracker.labels.extractable_tails",
          )?.message ?? ""
        );
      };
      expect(unknownTails('["hitl:legal", "pattern:flaky"]')).toBe("");
      // A closed category takes its own labels only, even where the slug is
      // a label elsewhere; an open pattern matches the whole slug.
      const message = unknownTails(
        '["hitl:finance", "hitl:bug", "pattern:Foo bar", "pattern:flaky2"]',
      );
      expect(message).toContain(
        "names hitl:finance, hitl:bug, pattern:Foo bar, pattern:flaky2, which",
      );
    });

    test("an open category's bare prefix is not a label, even where its pattern matches an empty slug", () => {
      const { report } = fit({
        ".config/jig.yaml":
          'issue_tracker:\n  labels:\n    extractable_tails: ["pattern:"]\n',
        "label-taxonomy.yaml": `${taxonomy}categories:
  - id: pattern
    prefix: "pattern:"
    open: ".*"
`,
      });
      expect(
        report.findings.find(
          (f) => f.id === "taxonomy:issue_tracker.labels.extractable_tails",
        )?.message,
      ).toContain("names pattern:, which");
    });

    test("a configured taxonomy that does not exist is the schema's path finding alone", () => {
      const { report } = fit({
        ".config/jig.yaml": "issue_tracker:\n  taxonomy: docs/absent.yaml\n",
        "label-taxonomy.yaml": taxonomy,
      });
      expect(taxonomyIds(report)).toEqual([
        "derivation:issue_tracker.taxonomy",
      ]);
    });

    test("the older review.taxonomy label fields are checked too", () => {
      const { report } = fit({
        ".config/jig.yaml":
          "review:\n  taxonomy:\n    epic_label: initiative\n    provenance_label: epic\n",
        "label-taxonomy.yaml": taxonomy,
      });
      expect(ids(report).filter((id) => id.startsWith("taxonomy:"))).toEqual([
        "taxonomy:review.taxonomy.epic_label",
      ]);
    });
  });

  test("a clean file passes, and the integration branch must be known", () => {
    const { code, report } = fit({
      ".config/jig.yaml":
        "gates:\n  command: bun run gates\nrepository:\n  base_branch: main\n",
      "package.json": '{"scripts":{"gates":"true"}}',
    });
    expect(ids(report, "error")).toEqual([]);
    expect(code).toBe(0);
    expect(report.facts.integration_branch).toBe("main");

    const unknown = fit({ ".config/jig.yaml": 'gates:\n  command: "true"\n' });
    expect(ids(unknown.report, "error")).toEqual([]);
    expect(ids(unknown.report)).toContain("unchecked:integration-branch");
    const mistyped = fit({ ".config/jig.yaml": "gates:\n  command: true\n" });
    expect(ids(mistyped.report, "error")).toEqual(["type:gates.command"]);
  });

  test("a finding the record declines is listed as declined until its date", () => {
    const record = (after: string) => `version: 1
plugin_version: 0.13.0
date: 2026-01-02
commit: abc
criteria: {}
declined:
  - refs: [config/suggestion:gates.command]
    reason: Checks run in CI only.
    revisit_when: The team adds local hooks.
    revisit_after: "${after}"
`;
    const held = fit({ ".config/jig-audit.yaml": record("2999-01-01") }).report;
    expect(ids(held)).not.toContain("suggestion:gates.command");
    expect(held.declined.map((d) => d.finding.id)).toEqual([
      "suggestion:gates.command",
    ]);
    const due = fit({ ".config/jig-audit.yaml": record("2000-01-01") }).report;
    expect(ids(due)).toContain("suggestion:gates.command");
  });

  test("an error stays reported whatever the record declines", () => {
    const { code, report } = fit({
      ".config/jig.yaml": "gates:\n  command: true\n",
      ".config/jig-audit.yaml": `version: 1
plugin_version: 0.13.0
date: 2026-01-02
commit: abc
criteria: {}
declined:
  - refs: [config/type:gates.command]
    reason: Not now.
    revisit_when: Later.
`,
    });
    expect(code).toBe(1);
    expect(ids(report, "error")).toEqual(["type:gates.command"]);
    expect(report.declined).toEqual([]);
  });

  test("a catalog the configuration does not name is suggested", () => {
    const { report } = fit({ "docs/change-areas.yaml": "areas: {}\n" });
    expect(ids(report)).toContain("suggestion:drive.change_areas_catalog");
    // Offline the forge names no repository, so none is suggested.
    expect(ids(report)).not.toContain("suggestion:review.repo_slug");
  });

  test("offline, the starter still holds the gate command, and a declined suggestion leaves it", () => {
    const files = {
      "package.json": '{"scripts":{"test":"true"}}',
      "bun.lock": "",
      ".gitignore": ".context/\n",
    };
    const dir = repo(files);
    const run = runScript("config-fit.ts", ["--offline", "--draft"], dir);
    expect(run.code).toBe(0);
    expect(run.out).toEndWith(`gates:
  # package.json defines a "test" script, and bun.lock makes bun its package manager
  command: "bun run test"
`);
    // Written as the repository's file, the draft passes and leaves nothing to suggest.
    mkdirSync(join(dir, ".config"));
    writeFileSync(join(dir, ".config", "jig.yaml"), run.out);
    const again = runScript(
      "config-fit.ts",
      ["--offline", "--json"],
      dir,
      cleanEnv({ JIG_USER_LAYER: "off" }),
    );
    const report = JSON.parse(again.out) as Report;
    expect(ids(report, "error")).toEqual([]);
    expect(ids(report, "warning")).toEqual([]);
    expect(report.draft).toBeUndefined();
    expect(runScript("config-fit.ts", ["--offline", "--draft"], dir).out).toBe(
      `${NOTHING_TO_SUGGEST}\n`,
    );

    const declined = fit({
      ...files,
      ".config/jig-audit.yaml": `version: 1
plugin_version: 0.13.0
date: 2026-01-02
commit: abc
criteria: {}
declined:
  - refs: [config/suggestion:gates.command]
    reason: Checks run in CI only.
    revisit_when: The team adds local hooks.
`,
    }).report;
    expect(declined.suggestions).toEqual([]);
    expect(declined.draft).toBeUndefined();
  });

  test("--draft exits 0 whatever the findings, and does not combine with --json", () => {
    const dir = repo({
      ".config/jig.yaml": "gates:\n  command: true\n",
      Makefile: "check:\n\ttrue\n",
    });
    const run = runScript("config-fit.ts", ["--offline", "--draft"], dir);
    expect(run.code).toBe(0);
    expect(run.out).toBe(`${NOTHING_TO_SUGGEST}\n`);
    expect(runScript("config-fit.ts", ["--draft", "--json"], dir).code).toBe(2);
  });
});

describe.skipIf(process.platform === "win32")("the forge", () => {
  const pulls = (checks: string[], logins: string[]) =>
    JSON.stringify(
      [1, 2, 3].map((n) => ({
        number: n,
        title: `feat: change ${n} (ENG-${n})`,
        headRefName: `eng-${n}-change`,
        baseRefName: "main",
        statusCheckRollup: checks.map((name) => ({ name })),
        reviews: logins.map((login) => ({ author: { login } })),
        comments: [],
      })),
    );
  const answers = (over: Record<string, string> = {}) => ({
    "repo view": JSON.stringify({
      nameWithOwner: "example/web",
      defaultBranchRef: { name: "main" },
      deleteBranchOnMerge: false,
    }),
    "branches/main/protection": JSON.stringify({
      required_status_checks: { contexts: ["build"], checks: [] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    }),
    "rules/branches/main": JSON.stringify([
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "lint" }] },
      },
    ]),
    "--state merged": pulls(["build"], ["example-review", "a-person"]),
    "--state open": JSON.stringify([
      { number: 7, baseRefName: "main", headRefName: "eng-7-change" },
      { number: 8, baseRefName: "eng-7-change", headRefName: "eng-8-more" },
      // Into a release branch, which no open pull request is: not stacked.
      { number: 9, baseRefName: "release-1.x", headRefName: "backport-fix" },
    ]),
    "label list": JSON.stringify([{ name: "agent-authored" }]),
    "users/example-review[bot]": JSON.stringify({ type: "Bot" }),
    ...over,
  });

  function online(
    config: string,
    over?: Record<string, string>,
    files: Record<string, string> = {},
  ) {
    return onlineIn(repo({ ".config/jig.yaml": config, ...files }), over);
  }

  /** config-fit against the fake forge, in an existing repository. */
  function onlineIn(dir: string, over?: Record<string, string>) {
    const bin = fakeGh(dir, answers(over));
    return fitIn(dir, [], cleanEnv({ PATH: withPath(bin) }));
  }

  test("required checks that never ran, stacking, labels, reviewers and issue keys", () => {
    const report = online(`repository:
  base_branch: main
review:
  bots: ["ghost-review[bot]"]
pull_requests:
  stacking: none
  labels: [agent-authored, missing-label]
`);
    expect(report.forge).toBe("checked");
    expect(report.facts.branch_protection).toBe("requires build, lint");
    expect(report.facts.required_reviews).toBe("1");
    expect(report.facts.stacked_open_pulls).toBe("1");
    const all = ids(report);
    expect(all).toContain("derivation:required-check:lint");
    expect(all).not.toContain("derivation:required-check:build");
    expect(all).toContain("contradiction:pull_requests.stacking");
    expect(all).toContain("derivation:pull_requests.labels:missing-label");
    expect(all).not.toContain("derivation:pull_requests.labels:agent-authored");
    expect(all).toContain("contradiction:review.bots:ghost-review[bot]");
    expect(all).toContain("suggestion:issue_tracker.team");
  });

  test("a full page of open pull requests leaves a base it does not contain unchecked, not unstacked", () => {
    const page = Array.from({ length: 200 }, (_, i) => ({
      number: 100 + i,
      baseRefName: "main",
      headRefName: `eng-${100 + i}-change`,
    }));
    // Based on a pull request the page left out.
    page[0] = { number: 100, baseRefName: "eng-1-older", headRefName: "x" };
    const full = online("repository:\n  base_branch: main\n", {
      "--state open": JSON.stringify(page),
    });
    expect(full.facts.stacked_open_pulls).toBe("at least 0");
    expect(ids(full)).toContain("unchecked:stacked-open-pulls");
    expect(ids(full)).not.toContain("contradiction:pull_requests.stacking");

    // Below the limit the page is complete: an unknown base is not a stack.
    const partial = online("repository:\n  base_branch: main\n", {
      "--state open": JSON.stringify(page.slice(0, 199)),
    });
    expect(partial.facts.stacked_open_pulls).toBe("0");
    expect(ids(partial)).not.toContain("unchecked:stacked-open-pulls");
  });

  test("list fields of the wrong type are reported, not fatal", () => {
    const report = online(
      "repository:\n  base_branch: main\nreview:\n  bots: [5]\nci:\n  required_checks: [7]\npull_requests:\n  labels: [3]\n",
    );
    expect(ids(report, "error")).toContain("type:review.bots");
    expect(report.forge).toBe("checked");
  });

  test("a reviewer seen on recent pull requests is suggested when none is declared", () => {
    const report = online("repository:\n  base_branch: main\n");
    expect(ids(report)).toContain("suggestion:review.bots:example-review");
    expect(ids(report)).not.toContain("suggestion:review.bots:a-person");
    // Undeclared stacking reads as none: a suggestion, not a contradiction.
    expect(
      report.findings.find(
        (f) => f.id === "contradiction:pull_requests.stacking",
      )?.severity,
    ).toBe("suggestion");
  });

  test("a suggested reviewer gains [bot] only when the forge says it is a bot, and keeps its login only when the forge says it is not", () => {
    const report = online("repository:\n  base_branch: main\n", {
      "--state merged": pulls(
        ["build"],
        ["example-review", "alice-review", "other-review"],
      ),
      "users/alice-review[bot]": "!gh: Not Found (HTTP 404)",
      "users/other-review[bot]": "!HTTP 502: Bad Gateway",
    });
    const value = (key: string) =>
      report.suggestions.find((s) => s.key === key)?.value;
    expect(value("example-review")).toEqual(["example-review[bot]"]);
    expect(value("alice-review")).toEqual(["alice-review"]);
    // A lookup that failed confirms nothing: no value, and the login is unchecked.
    expect(value("other-review")).toBeUndefined();
    expect(ids(report)).toContain("unchecked:review.bots:other-review");
    expect(ids(report)).not.toContain("suggestion:review.bots:other-review");
  });

  test("the repository's name and its stacking are suggested only where the file leaves them unset", () => {
    const unset = online("repository:\n  base_branch: main\n");
    const field = (r: Report, name: string) =>
      r.suggestions.find((s) => s.field === name);
    expect(field(unset, "review.repo_slug")).toMatchObject({
      value: "example/web",
      evidence: "the forge names this repository example/web",
    });
    expect(ids(unset)).toContain("suggestion:review.repo_slug");
    expect(field(unset, "pull_requests.stacking")?.value).toBe("branch");
    // The value answers the finding that reports the unset field, which keeps its id and message.
    expect(ids(unset).filter((id) => id.includes("stacking"))).toEqual([
      "contradiction:pull_requests.stacking",
    ]);
    expect(
      unset.findings.find(
        (f) => f.id === "contradiction:pull_requests.stacking",
      ),
    ).toEqual({
      id: "contradiction:pull_requests.stacking",
      severity: "suggestion",
      message:
        "1 open pull request(s) are based on another open pull request's branch, not main (#8 → eng-7-change), but pull_requests.stacking is unset (none): declare native or branch, or stop stacking",
    });
    const added = load(unset.draft ?? "") as Record<string, unknown>;
    expect(checkConfig(added, loadSchema())).toEqual([]);
    expect(added).toMatchObject({
      review: { repo_slug: "example/web" },
      pull_requests: { stacking: "branch" },
    });

    const set = online(`repository:
  base_branch: main
review:
  repo_slug: example/web
pull_requests:
  stacking: none
`);
    expect(set.suggestions.map((s) => s.field)).not.toContain(
      "review.repo_slug",
    );
    expect(set.suggestions.map((s) => s.field)).not.toContain(
      "pull_requests.stacking",
    );
    expect(
      set.findings.find((f) => f.id === "contradiction:pull_requests.stacking"),
    ).toMatchObject({
      severity: "warning",
      message: expect.stringContaining("pull_requests.stacking is none:"),
    });
    expect(set.draft ?? "").not.toContain("repo_slug");
  });

  test("no stacked pull request, no stacking value; a declined contradiction drops it", () => {
    const flat = online("repository:\n  base_branch: main\n", {
      "--state open": JSON.stringify([
        { number: 7, baseRefName: "main", headRefName: "eng-7-change" },
        { number: 9, baseRefName: "release-1.x", headRefName: "backport-fix" },
      ]),
    });
    expect(flat.suggestions.map((s) => s.field)).not.toContain(
      "pull_requests.stacking",
    );
    const declined = online("repository:\n  base_branch: main\n", undefined, {
      ".config/jig-audit.yaml": `version: 1
plugin_version: 0.13.0
date: 2026-01-02
commit: abc
criteria: {}
declined:
  - refs: [config/contradiction:pull_requests.stacking]
    reason: The stacks are short-lived experiments.
    revisit_when: Stacks reach review.
`,
    });
    expect(declined.declined.map((d) => d.finding.id)).toEqual([
      "contradiction:pull_requests.stacking",
    ]);
    expect(declined.suggestions.map((s) => s.field)).not.toContain(
      "pull_requests.stacking",
    );
    expect(declined.draft ?? "").not.toContain("stacking");
  });

  test("branch stacking warns when merged branches are kept", () => {
    const report = online(
      "repository:\n  base_branch: main\npull_requests:\n  stacking: branch\n",
    );
    expect(ids(report)).toContain("contradiction:delete-branch-on-merge");
  });

  test("unreadable labels and no merged pull requests are unchecked", () => {
    const report = online(
      "repository:\n  base_branch: main\npull_requests:\n  labels: [agent-authored]\n",
      { "label list": "!HTTP 403", "--state merged": "[]" },
    );
    expect(ids(report)).toContain("unchecked:pull_requests.labels");
    expect(ids(report)).toContain("unchecked:merged-pulls");
  });

  test("a branch anyone can see is unprotected counts as known", () => {
    const report = online("repository:\n  base_branch: main\n", {
      "branches/main/protection": "!HTTP 404: Not Found",
      "rules/branches/main": "[]",
      "api repos/example/web/branches/main": JSON.stringify({
        protected: false,
      }),
    });
    expect(report.facts.branch_protection).toBe(
      "none: no branch protection and no ruleset",
    );
    expect(
      report.findings.find((f) => f.id === "fact:no-required-checks")?.message,
    ).toStartWith("main is unprotected (no branch protection and no ruleset)");
    // Protected, but with no required check: said apart from unprotected.
    const unchecked = online("repository:\n  base_branch: main\n", {
      "branches/main/protection": JSON.stringify({}),
      "rules/branches/main": "[]",
    });
    expect(unchecked.facts.branch_protection).toBe("requires no checks");
    expect(
      unchecked.findings.find((f) => f.id === "fact:no-required-checks")
        ?.message,
    ).toStartWith("main is protected but requires no status checks");
  });

  test("the repository's file is judged alone; this machine's layers are reported", () => {
    const home = mkdtempSync(join(tmpdir(), "jig-home-"));
    // Merged with the repository's file, this would make the review skill refuse it.
    writeFileSync(
      join(home, "jig.yaml"),
      "review:\n  sticky_marker: 5\ndrive:\n  reviews_drafts: true\ngates:\n  command: make check\n",
    );
    const { report } = fit(
      { ".config/jig.yaml": 'review:\n  bots: ["a[bot]"]\n' },
      ["--offline"],
      cleanEnv({ JIG_HOME: home, JIG__REVIEW__STICKY_MARKER: "x" }),
    );
    expect(ids(report, "error")).toEqual([]);
    const user = report.findings.find((f) => f.id === "fact:user-layer");
    expect(user?.message).toContain(
      "review.sticky_marker, drive.reviews_drafts",
    );
    expect(user?.message).not.toContain("review.bots");
    const layer = report.findings.find(
      (f) => f.id === "fact:environment-layer",
    );
    expect(layer?.message).toContain("except for the tracker check");
    // A field that describes one repository makes every skill refuse the user file.
    expect(
      report.findings.find((f) => f.id === "fact:user-layer-refused")?.message,
    ).toContain("sets gates.command,");
  });

  test("a forge that cannot be read is unchecked, never passing", () => {
    const report = online("repository:\n  base_branch: main\n", {
      "repo view": "!HTTP 401: bad credentials",
    });
    expect(report.forge).toBe("unchecked");
    expect(ids(report)).toContain("unchecked:forge");
    const protectedUnknown = online("repository:\n  base_branch: main\n", {
      "branches/main/protection": "!HTTP 403: forbidden",
    });
    expect(protectedUnknown.facts.branch_protection).toStartWith("unchecked");
  });

  test("an unconfigured repository gets a whole starter file from what it shows", () => {
    const dir = repo({
      "package.json": '{"scripts":{"test":"true"}}',
      "docs/change-areas.yaml": "areas: {}\n",
    });
    const env = cleanEnv({ PATH: withPath(fakeGh(dir, answers())) });
    const run = runScript("config-fit.ts", ["--json"], dir, env);
    const report = JSON.parse(run.out) as Report;
    expect(report.suggestions.map((s) => s.field)).toEqual([
      "review.bots",
      "pull_requests.stacking",
      "review.repo_slug",
      "issue_tracker.adapter",
      "issue_tracker.team",
      "drive.change_areas_catalog",
      "gates.command",
    ]);
    const draft = report.draft ?? "";
    expect(draft).toStartWith("# Jig configuration for this repository");
    expect(draft).toContain(
      "# Generated by /jig:audit config-fit; review before committing.",
    );
    expect(draft).toContain(`review:
  # example-review reviewed 3 of the last 3 merged pull requests
  bots: ["example-review[bot]"]
  # the forge names this repository example/web
  repo_slug: example/web
pull_requests:
  # 1 open pull request(s) are based on another open pull request's branch, not main (#8 → eng-7-change): base-branch chaining; native instead if they are linked as a GitHub stack
  stacking: branch
issue_tracker:
  # ENG-<n> issue keys in 3 of the last 3 merged pull requests
  adapter: linear
  # ENG-<n> issue keys in 3 of the last 3 merged pull requests
  team: ENG
drive:
  # docs/change-areas.yaml is tracked and named like a change-area catalog
  change_areas_catalog: docs/change-areas.yaml
gates:
  # package.json defines a "test" script
  command: "npm run test"
`);
    const parsed = load(draft) as Record<string, unknown>;
    expect(checkConfig(parsed, loadSchema())).toEqual([]);
    expect(parsed).toEqual({
      review: { bots: ["example-review[bot]"], repo_slug: "example/web" },
      issue_tracker: { adapter: "linear", team: "ENG" },
      pull_requests: { stacking: "branch" },
      drive: { change_areas_catalog: "docs/change-areas.yaml" },
      gates: { command: "npm run test" },
    });
    // The finding ids and messages stay as they were.
    expect(ids(report)).toContain("suggestion:review.bots:example-review");
    expect(ids(report)).toContain("suggestion:issue_tracker.team");
    // The Markdown report shows the same draft in its own section.
    const text = runScript("config-fit.ts", [], dir, env).out;
    expect(text).toContain(
      `## Starter configuration\n\n\`\`\`yaml\n${draft}\`\`\``,
    );
  });

  test("a configured repository gets only the fields it does not set", () => {
    const report = online(`repository:
  base_branch: main
gates:
  command: "true"
`);
    expect(report.draft).toStartWith("# Add to .config/jig.yaml:\nreview:\n");
    expect(report.draft).not.toContain("gates:");
    expect(report.draft).not.toContain("repository:");
    const added = load(report.draft ?? "") as Record<string, unknown>;
    expect(added).toEqual({
      review: { bots: ["example-review[bot]"], repo_slug: "example/web" },
      issue_tracker: { adapter: "linear", team: "ENG" },
      pull_requests: { stacking: "branch" },
    });
    expect(checkConfig(added, loadSchema())).toEqual([]);
  });

  test("a tracker without credentials cannot be reached", () => {
    const dir = repo({
      ".config/jig.yaml":
        "repository:\n  base_branch: main\nissue_tracker:\n  adapter: linear\n  team: ENG\n",
    });
    const bin = fakeGh(dir, answers());
    // Only the fake gh and the system tools: no tracker client, no credential.
    const env = cleanEnv({ PATH: `${bin}:/usr/bin:/bin` });
    const report = JSON.parse(
      runScript("config-fit.ts", ["--json"], dir, env).out,
    ) as Report;
    expect(
      report.findings.find((f) => f.id === "derivation:issue_tracker")?.message,
    ).toContain("cannot be reached");
  });
  describe("a configured repository without a tracker section", () => {
    /**
     * The tracker finding, and config-fit's exit status, when it runs in
     * `cwd` on the repository `JIG_CONSUMER_ROOT` names (the working
     * directory when unset), the fake forge answering GraphQL with
     * `graphql`, with `extra` set.
     */
    function trackerFinding(
      graphql: string,
      cwd?: string,
      extra: Record<string, string> = {},
    ): { finding: Report["findings"][number] | undefined; code: number } {
      const dir = repo({
        ".config/jig.yaml": "repository:\n  base_branch: main\n",
      });
      git(dir, "remote", "add", "origin", "https://github.com/example/web.git");
      const bin = fakeGh(dir, { ...answers(), "api graphql": graphql });
      const env = cleanEnv({
        PATH: withPath(bin),
        ...(cwd === undefined ? {} : { JIG_CONSUMER_ROOT: dir }),
        ...extra,
      });
      const run = runScript("config-fit.ts", ["--json"], cwd ?? dir, env);
      const { findings } = JSON.parse(run.out) as Report;
      const finding = findings.find((f) => f.id === "derivation:issue_tracker");
      return { finding, code: run.code };
    }
    // The repository answers; its issue #1 is one no issue read can parse,
    // so a probe that read an issue would fail.
    const REACHED = JSON.stringify({
      data: { repository: { id: "R_1", issue: { number: 1 } } },
    });

    test("probes the audited repository, reading no issue", () => {
      expect(trackerFinding(REACHED).finding).toBeUndefined();
      // The working directory has no origin remote; the audited one does.
      expect(trackerFinding(REACHED, repo({})).finding).toBeUndefined();
    });

    // Each fails the audit. Only the first forge fails, so only a probe of
    // the default tracker passes the rest; Linear answers through the fake
    // client fakeGh installs, never a real one.
    test.each([
      ["!fake forge: no answer", {}, /github tracker .*fake forge/],
      [
        REACHED,
        { ADAPTER: "linear", TEAM: "ENG" },
        /linear tracker .*fake linear/,
      ],
      [REACHED, { ADAPTER: "[x" }, /every skill here refuses to run/],
      [REACHED, { ADAPTER: "jira" }, /'jira' is not supported/],
    ] as const)("%s with %o is an error: %p", (graphql, tracker, message) => {
      const layer = Object.fromEntries(
        Object.entries(tracker).map(([k, v]) => [
          `JIG__ISSUE_TRACKER__${k}`,
          v,
        ]),
      );
      const r = trackerFinding(graphql, undefined, {
        JIG_USER_LAYER: "off",
        ...layer,
      });
      expect(r.finding?.severity).toBe("error");
      expect(r.finding?.message).toMatch(message);
      expect(r.code).toBe(1);
    });
  });

  test("the forge's default branch wins over a stale origin/HEAD, which is warned", () => {
    const stale = repo({ ".config/jig.yaml": 'gates:\n  command: "true"\n' });
    withOrigin(stale, { main: null, develop: null }, "main");
    const report = onlineIn(stale, {
      "repo view": JSON.stringify({
        nameWithOwner: "example/web",
        defaultBranchRef: { name: "develop" },
      }),
    });
    expect(report.facts.integration_branch).toBe("develop");
    expect(report.facts.integration_branch_source).toBe(
      "the forge's default branch",
    );
    expect(
      report.findings.find((f) => f.id === "fact:origin-head-differs"),
    ).toMatchObject({
      severity: "warning",
      message: expect.stringContaining("git remote set-head origin --auto"),
    });

    const agreeing = repo({
      ".config/jig.yaml": 'gates:\n  command: "true"\n',
    });
    withOrigin(agreeing, { main: null }, "main");
    const same = onlineIn(agreeing);
    expect(same.facts.integration_branch).toBe("main");
    expect(ids(same)).not.toContain("fact:origin-head-differs");

    // A declared branch is the integration branch whatever the forge says.
    const declared = repo({
      ".config/jig.yaml": "repository:\n  base_branch: main\n",
    });
    withOrigin(declared, { main: null, develop: null }, "main");
    const kept = onlineIn(declared, {
      "repo view": JSON.stringify({
        nameWithOwner: "example/web",
        defaultBranchRef: { name: "develop" },
      }),
    });
    expect(kept.facts.integration_branch).toBe("main");
    expect(ids(kept)).not.toContain("fact:origin-head-differs");
  });

  test("the tracker team counts keys in pull requests, commit subjects and branches, per source", () => {
    const dir = repo({ ".config/jig.yaml": 'gates:\n  command: "true"\n' });
    for (const n of [1, 2, 3, 4, 5]) commit(dir, `fix: change ${n} (OPS-${n})`);
    withOrigin(dir, { main: null, "ops-6-more": null, "feature/OPS-7": null });
    const report = onlineIn(dir);
    const team = report.suggestions.find(
      (s) => s.field === "issue_tracker.team",
    );
    expect(team?.value).toBe("OPS");
    // The merged pull requests carry ENG keys; the history outweighs them.
    expect(team?.evidence).toBe(
      "OPS-<n> issue keys in 5 of the last 6 commit subjects on origin/main, 2 of the 2 most recent branches on origin (3 key(s) of other teams)",
    );

    // Keys split between teams settle nothing.
    const split = repo({ ".config/jig.yaml": 'gates:\n  command: "true"\n' });
    for (const n of [1, 2, 3]) commit(split, `fix: change ${n} (OPS-${n})`);
    withOrigin(split, { main: null });
    expect(onlineIn(split).suggestions.map((s) => s.field)).not.toContain(
      "issue_tracker.team",
    );
  });

  test("a reviewer-looking check that ran while no reviewer is named is warned", () => {
    const unnamed = online("repository:\n  base_branch: main\n", {
      "--state merged": pulls(["build", "AI review"], []),
    });
    expect(
      unnamed.findings.find(
        (f) => f.id === "contradiction:review.reviewer-unnamed",
      ),
    ).toMatchObject({
      severity: "warning",
      message: expect.stringContaining(
        '"AI review" ran on 3 of the last 3 merged pull requests',
      ),
    });
    const message = (checks: string[]) =>
      online("repository:\n  base_branch: main\n", {
        "--state merged": pulls(checks, []),
      }).findings.find((f) => f.id === "contradiction:review.reviewer-unnamed")
        ?.message ?? "";
    // The default pattern matches, but the drive applies it only once a reviewer is named.
    expect(message(["AI review"])).toContain(
      "matched case-insensitively) matches it, so if a drive should wait for its findings, setting review.reviewer_app to the app that posts it is enough",
    );
    expect(message(["Claude code review"])).toContain(
      'does not match "Claude code review", so if a drive should wait for its findings, set review.reviewer_check_pattern',
    );
    // A skipped check did not run: a dormant reviewer arm is not a reviewer.
    const skipped = online("repository:\n  base_branch: main\n", {
      "--state merged": JSON.stringify(
        JSON.parse(pulls(["build"], [])).map((p: Record<string, unknown>) => ({
          ...p,
          statusCheckRollup: [{ name: "AI review", conclusion: "SKIPPED" }],
        })),
      ),
    });
    expect(ids(skipped)).not.toContain("contradiction:review.reviewer-unnamed");
    // Plain checks are no reviewer.
    expect(ids(online("repository:\n  base_branch: main\n"))).not.toContain(
      "contradiction:review.reviewer-unnamed",
    );
  });

  test("a named reviewer that posted on no recent pull request is warned", () => {
    const silent = (review: string, over?: Record<string, string>) =>
      ids(online(`repository:\n  base_branch: main\nreview:\n${review}`, over));
    expect(silent("  reviewer_app: ghost-app\n")).toContain(
      "contradiction:review.reviewer",
    );
    expect(silent('  reviewer_check_pattern: "^Claude review$"\n')).toContain(
      "contradiction:review.reviewer",
    );
    // A review by the app, or a check its pattern matches, shows it posts.
    expect(silent("  reviewer_app: example-review\n")).not.toContain(
      "contradiction:review.reviewer",
    );
    expect(
      silent('  reviewer_check_pattern: "^Claude review$"\n', {
        "--state merged": pulls(["Claude review"], []),
      }),
    ).not.toContain("contradiction:review.reviewer");
    expect(
      silent("  reviewer_app: ghost-app\n", {
        "--state merged": pulls(["AI review (shadow)"], []),
      }),
    ).not.toContain("contradiction:review.reviewer");
  });

  test("the gate is compared with the jobs behind the required checks", () => {
    const workflow = `on: [pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: bun run build
  other:
    runs-on: ubuntu-latest
    steps:
      - run: bun run other
`;
    const report = online(
      "repository:\n  base_branch: main\ngates:\n  command: bun run lint\n",
      undefined,
      {
        ".github/workflows/ci.yml": workflow,
        "package.json":
          '{"scripts":{"lint":"true","build":"true","other":"true"}}',
      },
    );
    const finding = report.findings.find(
      (f) => f.id === "suggestion:gates.command:ci",
    );
    // The branch requires "build" and "lint": only the build job is compared.
    expect(finding?.message).toContain(
      "`bun run build` (.github/workflows/ci.yml, job build)",
    );
    expect(finding?.message).not.toContain("bun run other");
  });
});

describe("the repository around the configuration", () => {
  test("HEAD behind the integration branch is reported, as of the last fetch", () => {
    const dir = repo({ ".gitignore": ".context/\n" });
    const first = git(dir, "rev-parse", "HEAD");
    commit(dir, "second");
    commit(dir, "third");
    withOrigin(dir, { main: null }, "main");
    git(dir, "checkout", "-q", first);
    const behind = fitIn(dir, ["--offline"]);
    expect(behind.facts.integration_branch_source).toBe("origin/HEAD");
    expect(behind.facts.behind_integration_branch).toStartWith(
      "2 commit(s) of origin/main not in HEAD",
    );
    expect(
      behind.findings.find((f) => f.id === "fact:behind-integration-branch"),
    ).toMatchObject({
      severity: "warning",
      message: expect.stringContaining("HEAD lacks 2 commit(s) of origin/main"),
    });
    git(dir, "checkout", "-q", "main");
    const current = fitIn(dir, ["--offline"]);
    expect(current.facts.behind_integration_branch).toStartWith("0 commit(s)");
    expect(ids(current)).not.toContain("fact:behind-integration-branch");
  });

  test("a leftover groundwork overlay is an error alone and a warning beside jig.yaml", () => {
    const files = {
      ".config/groundwork-overlay.yaml": "gates:\n  command: make check\n",
      "AGENTS.md": "# Agents\n\nRun /groundwork:do-item to pick up work.\n",
      ".claude/settings.json":
        '{\n  "enabledPlugins": {\n    "groundwork@groundwork": true\n  }\n}\n',
      "mise.toml": "[env]\nGROUNDWORK_HOME = '~/.groundwork/'\n",
      "docs/history.md": "We used /groundwork:do-item.\n",
    };
    const alone = fit(files);
    expect(alone.code).toBe(1);
    expect(
      alone.report.findings.find((f) => f.id === "legacy-overlay"),
    ).toMatchObject({
      severity: "error",
      message: expect.stringContaining(
        "git mv .config/groundwork-overlay.yaml .config/jig.yaml",
      ),
    });
    const references = alone.report.findings.filter((f) =>
      f.id.startsWith("legacy-reference:"),
    );
    expect(references.map((f) => f.id)).toEqual([
      "legacy-reference:.claude/settings.json",
      "legacy-reference:AGENTS.md",
      "legacy-reference:mise.toml",
    ]);
    expect(references[0]?.message).toStartWith(".claude/settings.json:3 names");
    expect(references[0]?.message).toContain("`jig@jig`");
    expect(references[1]?.message).toContain(
      "change `/groundwork:` to `/jig:`",
    );
    expect(references[2]?.message).toContain("(`.groundwork/`, `GROUNDWORK_`)");

    const both = fit({
      ...files,
      ".config/jig.yaml": 'gates:\n  command: "true"\n',
    }).report;
    expect(both.findings.find((f) => f.id === "legacy-overlay")?.severity).toBe(
      "warning",
    );
    expect(ids(fit({ "README.md": "# x\n" }).report)).not.toContain(
      "legacy-overlay",
    );
  });

  test("every agent instruction surface is scanned for the old names", () => {
    const { report } = fit({
      ".agents/skills/pickup/SKILL.md": "Run /groundwork:do-item.\n",
      ".cursor/rules/work.mdc": "Run /groundwork:do-item.\n",
      ".cursorrules": "Run /groundwork:do-item.\n",
      ".github/copilot-instructions.md": "Run /groundwork:do-item.\n",
      "docs/history.md": "We used /groundwork:do-item.\n",
    });
    expect(
      report.findings
        .filter((f) => f.id.startsWith("legacy-reference:"))
        .map((f) => f.id),
    ).toEqual([
      "legacy-reference:.agents/skills/pickup/SKILL.md",
      "legacy-reference:.cursor/rules/work.mdc",
      "legacy-reference:.cursorrules",
      "legacy-reference:.github/copilot-instructions.md",
    ]);
  });

  test("a field the groundwork overlay used says what replaces it", () => {
    const { report } = fit({
      ".config/jig.yaml":
        "schema_version: 2\nrepo_label: web\nreview:\n  dormant_check_pattern: x\nissue_tracker:\n  system: linear\n",
    });
    const message = (id: string) =>
      report.findings.find((f) => f.id === id)?.message ?? "";
    for (const id of [
      "unknown:schema_version",
      "unknown:repo_label",
      "unknown:review.dormant_check_pattern",
      "unknown:issue_tracker.system",
    ])
      expect(message(id)).toContain("left from the former groundwork overlay");
    expect(message("unknown:schema_version")).toContain("dropping it is safe");
    expect(message("unknown:repo_label")).toContain("review.repo_label");
    expect(message("unknown:issue_tracker.system")).toContain(
      "issue_tracker.adapter",
    );
  });

  test(".context/ not ignored by git is a warning", () => {
    expect(ids(fit({ "README.md": "# x\n" }).report)).toContain(
      "context-dir-not-ignored",
    );
    expect(ids(fit({ ".gitignore": ".context/\n" }).report)).not.toContain(
      "context-dir-not-ignored",
    );
  });

  test("a slash command in issue_tracker.file_command must resolve", () => {
    const fileCommand = (value: string, files: Record<string, string> = {}) =>
      fit({
        ".config/jig.yaml": `issue_tracker:\n  file_command: "${value}"\n`,
        ...files,
      }).report.findings.filter((f) =>
        f.id.endsWith("issue_tracker.file_command"),
      );
    expect(fileCommand("/open-ticket")).toMatchObject([
      {
        id: "derivation:issue_tracker.file_command",
        severity: "warning",
        message: expect.stringContaining(".claude/commands/open-ticket.md"),
      },
    ]);
    for (const resolved of [
      ".claude/commands/open-ticket.md",
      ".claude/commands/tracker/open-ticket.md",
      ".claude/skills/open-ticket/SKILL.md",
    ])
      expect(fileCommand("/open-ticket", { [resolved]: "x\n" })).toEqual([]);
    expect(fileCommand("/jig:do-item")).toEqual([]);
    expect(fileCommand("/jig:file-issue")).toEqual([]);
    // A bare name runs this plugin's skill when nothing else has it.
    expect(fileCommand("/do-item")).toEqual([]);
    expect(fileCommand("/jig:no-such-skill")[0]?.id).toBe(
      "derivation:issue_tracker.file_command",
    );
    expect(fileCommand("/tracker:file")).toMatchObject([
      { id: "unchecked:issue_tracker.file_command", severity: "info" },
    ]);
    expect(fileCommand("linear issue create")).toEqual([]);
  });

  describe("the gate command against CI", () => {
    const gateFit = (
      command: string,
      scripts: Record<string, string>,
      workflow: string,
      extra = "",
    ) =>
      fit({
        ".config/jig.yaml": `gates:\n  command: "${command}"\n${extra}`,
        "package.json": JSON.stringify({ scripts }),
        ".github/workflows/ci.yml": workflow,
      }).report.findings.find((f) => f.id === "suggestion:gates.command:ci");
    const workflow = `on:
  pull_request:
jobs:
  check:
    name: Checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bun install --frozen-lockfile
      - run: |
          bun run lint
          bun run lint:licenses \\
            --strict
          ./scripts/check-analytics.sh
      - run: echo "\${{ github.sha }}" && bun run never-compared
`;

    test("what CI runs and the gate does not is a suggestion", () => {
      const finding = gateFit(
        "bun run gates",
        {
          gates: "bun run lint && bun test",
          lint: "true",
          "lint:licenses": "true",
        },
        workflow,
      );
      expect(finding?.severity).toBe("suggestion");
      expect(finding?.message).toContain(
        "`bun run lint:licenses --strict` (.github/workflows/ci.yml, job check)",
      );
      expect(finding?.message).toContain("`./scripts/check-analytics.sh`");
      // Covered through the gates script, setup, and templated lines are not listed.
      expect(finding?.message).not.toContain("`bun run lint`");
      expect(finding?.message).not.toContain("bun install");
      expect(finding?.message).not.toContain("never-compared");
      expect(finding?.message).toContain("may be listed");
    });

    test("a gate that runs what CI runs, directly or through a script, has no finding", () => {
      expect(
        gateFit(
          "bun run gates",
          {
            gates:
              "bun run lint && bun run lint:licenses --strict && ./scripts/check-analytics.sh",
            lint: "true",
            "lint:licenses": "true",
          },
          workflow,
        ),
      ).toBeUndefined();
      // Flags are not compared, and a step in another folder or shell is left out.
      expect(
        gateFit(
          "bun test",
          {},
          "on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test --coverage\n      - run: npm run e2e\n        working-directory: web\n      - run: print('x')\n        shell: python\n",
        ),
      ).toBeUndefined();
      // A file CI runs that the gate's own runner or makefile names is covered.
      for (const [command, runner] of [
        ["bash scripts/gates.sh", "scripts/gates.sh"],
        ["make check", "Makefile"],
      ] as const) {
        const covered = fit({
          ".config/jig.yaml": `gates:\n  command: "${command}"\n`,
          [runner]: "check:\n\t./scripts/check-analytics.sh\n",
          "scripts/check-analytics.sh": "",
          ".github/workflows/ci.yml":
            "on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./scripts/check-analytics.sh\n",
        }).report;
        expect(ids(covered)).not.toContain("suggestion:gates.command:ci");
      }
      // CI running a script whose every command the gate runs is covered too.
      expect(
        gateFit(
          "bun run lint && bun test",
          { lint: "true", check: "bun run lint && bun test" },
          "on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: bun run check\n",
        ),
      ).toBeUndefined();
    });

    test("a CI step the comparison does not read is reported unchecked, not as covered", () => {
      const unchecked = (run: string) =>
        fit({
          ".config/jig.yaml": 'gates:\n  command: "bun test"\n',
          "package.json": "{}",
          ".github/workflows/ci.yml": `on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
        }).report.findings.filter((f) => f.id.endsWith("gates.command:ci"));
      for (const run of [
        "bun run lint\necho 'usage: <<EOF'",
        "bun run lint\necho ready # <<EOF",
        "cd web && bun run lint",
        "if true; then\n  bun run lint\nfi",
        "bun run lint > lint.log",
        // A workflow expression, written apart so it does not read as a template.
        `bun run lint --filter ${"$"}{{ matrix.pkg }}`,
      ])
        expect(unchecked(run)).toMatchObject([
          {
            id: "unchecked:gates.command:ci",
            severity: "info",
            message: expect.stringContaining(
              ".github/workflows/ci.yml, job ci has `run` steps this comparison does not read",
            ),
          },
        ]);
      // A block it reads is compared as before, and is not reported.
      expect(unchecked("bun test\nbun run lint").map((f) => f.id)).toEqual([
        "suggestion:gates.command:ci",
      ]);
    });

    /** The suggestion's message when the gate runs one runner file, by its language. */
    const runnerFit = (file: string, text: string) =>
      fit({
        ".config/jig.yaml": `gates:\n  command: "${file.endsWith(".sh") ? "bash" : file.endsWith(".py") ? "python3" : "bun"} ${file}"\n`,
        [file]: text,
        "scripts/check-analytics.sh": "",
        ".github/workflows/ci.yml":
          "on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./scripts/check-analytics.sh\n",
      }).report.findings.find((f) => f.id === "suggestion:gates.command:ci")
        ?.message;

    test.each([
      [
        "scripts/gates.ts",
        "// TODO: run scripts/check-analytics.sh\nconsole.log('ok');\n",
      ],
      ["scripts/gates.sh", "# ./scripts/check-analytics.sh is not run yet\n"],
      ["scripts/gates.ts", "await $`./tools/check-analytics.sh`;\n"],
      ["scripts/gates.ts", "console.log('scripts/check-analytics.sh');\n"],
      ["scripts/gates.sh", "make test # TODO: scripts/check-analytics.sh\n"],
      [
        "scripts/gates.ts",
        "await run(['bun', 'test']); // then ./scripts/check-analytics.sh\n",
      ],
      ["scripts/gates.sh", "echo scripts/check-analytics.sh\n"],
      // A command or call shaped string is still only a string.
      [
        "scripts/gates.ts",
        "console.log('spawnSync(\"./scripts/check-analytics.sh\")');\n",
      ],
      ["scripts/gates.sh", 'echo "done; ./scripts/check-analytics.sh"\n'],
      ["scripts/gates.ts", "console.log(`./scripts/check-analytics.sh`);\n"],
      [
        "scripts/gates.ts",
        'log("say \\"hi\\"; bash scripts/check-analytics.sh");\n',
      ],
      // An escaped quote, a string over several lines, an inline block comment.
      [
        "scripts/gates.ts",
        "console.log('don\\'t; ./scripts/check-analytics.sh');\n",
      ],
      [
        "scripts/gates.ts",
        "console.log(`checks:\n./scripts/check-analytics.sh\n`);\n",
      ],
      [
        "scripts/gates.ts",
        'const x = 1; /* spawnSync("./scripts/check-analytics.sh"); */\n',
      ],
      ["scripts/gates.sh", "echo 'first line\n./scripts/check-analytics.sh'\n"],
      [
        "scripts/gates.py",
        '"""Runs:\n./scripts/check-analytics.sh\n"""\nprint("ok")  # spawnSync("./scripts/check-analytics.sh")\n',
      ],
      // A here-document's body, quoted, tab-indented or piped on.
      ["scripts/gates.sh", "cat <<'EOF'\n./scripts/check-analytics.sh\nEOF\n"],
      [
        "scripts/gates.sh",
        "cat <<-EOF\n\t./scripts/check-analytics.sh\n\tEOF\necho ok\n",
      ],
      [
        "scripts/gates.sh",
        'cat <<"EOF" | tee notes.txt\n./scripts/check-analytics.sh\nEOF\n',
      ],
      ["scripts/gates.sh", "cat <<EOF\n./scripts/check-analytics.sh\nEOF\n"],
      [
        "scripts/gates.sh",
        "cat <<END-TEXT\nEND\n./scripts/check-analytics.sh\nEND-TEXT\n",
      ],
      // A quoted empty delimiter, closed by an empty line.
      [
        "scripts/gates.sh",
        "cat <<''\n./scripts/check-analytics.sh\n\necho ok\n",
      ],
      // A double-quoted delimiter with an escaped quote in it.
      [
        "scripts/gates.sh",
        'cat <<"E\\"OF"\n./scripts/check-analytics.sh\nE"OF\n',
      ],
      // An unquoted body's backslash-newline joins the next line to it.
      [
        "scripts/gates.sh",
        "cat <<EOF\ntext \\\nEOF\n./scripts/check-analytics.sh\nEOF\n",
      ],
      // A quoted delimiter, or part of one, leaves the body's substitutions text.
      [
        "scripts/gates.sh",
        "cat <<'EOF'\n$(./scripts/check-analytics.sh)\nEOF\n",
      ],
      [
        "scripts/gates.sh",
        'cat <<E"OF"\n$(./scripts/check-analytics.sh)\nEOF\n',
      ],
      [
        "scripts/gates.sh",
        "cat <<EOF\n\\$(./scripts/check-analytics.sh)\nEOF\n",
      ],
      // An escaped separator is a literal argument.
      ["scripts/gates.sh", "echo \\; ./scripts/check-analytics.sh\n"],
      ["scripts/gates.sh", "echo \\| ./scripts/check-analytics.sh\n"],
      ["scripts/gates.sh", "echo \\& ./scripts/check-analytics.sh\n"],
      // An argument list no call runs.
      [
        "scripts/gates.ts",
        'const examples = ["bash", "scripts/check-analytics.sh"]; console.log("ok");\n',
      ],
      [
        "scripts/gates.ts",
        'console.log(["bash", "scripts/check-analytics.sh"]);\n',
      ],
    ] as const)(
      "a runner that only mentions a file CI runs, or names another file of that name, does not cover it [case %# %s]",
      (file, text) => {
        expect(runnerFit(file, text)).toContain(
          "`./scripts/check-analytics.sh`",
        );
      },
    );

    test.each([
      [
        "scripts/gates.sh",
        "set -e\nbun test && ./scripts/check-analytics.sh\n",
      ],
      [
        "scripts/gates.sh",
        "if true; then bash scripts/check-analytics.sh; fi\n",
      ],
      ["scripts/gates.ts", "await $`./scripts/check-analytics.sh`;\n"],
      [
        "scripts/gates.ts",
        "spawnSync('./scripts/check-analytics.sh', { stdio: 'inherit' });\n",
      ],
      ["scripts/gates.ts", 'run(["bash", "scripts/check-analytics.sh"]);\n'],
      [
        "scripts/gates.py",
        'subprocess.run(["bash", "scripts/check-analytics.sh"])\n',
      ],
      // A command substitution runs its command, inside double quotes too.
      ["scripts/gates.sh", 'echo "$(./scripts/check-analytics.sh)"\n'],
      ["scripts/gates.sh", "result=`./scripts/check-analytics.sh`\n"],
      // After a here-document, and on the line that opens one.
      [
        "scripts/gates.sh",
        "cat <<EOF\nnotes\nEOF\n./scripts/check-analytics.sh\n",
      ],
      [
        "scripts/gates.sh",
        "cat <<'EOF' && ./scripts/check-analytics.sh\nbody\nEOF\n",
      ],
      // A substitution in an unquoted body runs.
      ["scripts/gates.sh", "cat <<EOF\n$(./scripts/check-analytics.sh)\nEOF\n"],
      ["scripts/gates.sh", "cat <<EOF\n`./scripts/check-analytics.sh`\nEOF\n"],
      // A delimiter is a whole shell word, with its quotes removed.
      [
        "scripts/gates.sh",
        "cat <<END-TEXT\nbody\nEND-TEXT\n./scripts/check-analytics.sh\n",
      ],
      [
        "scripts/gates.sh",
        'cat <<E"OF"\nbody\nEOF\n./scripts/check-analytics.sh\n',
      ],
      [
        "scripts/gates.sh",
        'cat <<"E\\"OF"\nbody\nE"OF\n./scripts/check-analytics.sh\n',
      ],
      ["scripts/gates.sh", "cat <<''\nbody\n\n./scripts/check-analytics.sh\n"],
      // An unquoted body's closing line is a logical line; an escaped backslash continues nothing.
      [
        "scripts/gates.sh",
        "cat <<EOF\nbody\nEO\\\nF\n./scripts/check-analytics.sh\n",
      ],
      [
        "scripts/gates.sh",
        "cat <<EOF\ntext \\\\\nEOF\n./scripts/check-analytics.sh\nEOF\n",
      ],
      // A here-string, or a shift, opens no here-document.
      [
        "scripts/gates.sh",
        "cat <<<notes\n./scripts/check-analytics.sh\nnotes\n",
      ],
      ["scripts/gates.sh", "echo $((1<<2))\n./scripts/check-analytics.sh\n"],
      ["scripts/gates.sh", "(( n = 1<<2 ))\n./scripts/check-analytics.sh\n"],
      [
        "scripts/gates.ts",
        'spawnSync("bash", ["scripts/check-analytics.sh"]);\n',
      ],
    ] as const)(
      "a runner that runs a file CI runs, as a command or through a shell or spawn call, covers it [case %# %s]",
      (file, text) => {
        expect(runnerFit(file, text)).toBeUndefined();
      },
    );

    test("a yarn command other than an install is compared, not taken for setup", () => {
      const finding = gateFit(
        "bun test",
        { lint: "true" },
        "on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: yarn\n      - run: yarn install --frozen-lockfile\n      - run: yarn --immutable\n      - run: yarn lint\n      - run: yarn run check\n",
      );
      expect(finding?.message).toContain("`yarn lint`");
      expect(finding?.message).toContain("`yarn run check`");
      expect(finding?.message).not.toContain("`yarn`");
      expect(finding?.message).not.toContain("yarn install");
      expect(finding?.message).not.toContain("--immutable");
    });

    test("jobs pull requests do not run, or the required checks do not name, are not compared", () => {
      const push = workflow.replace("on:\n  pull_request:", "on:\n  push:");
      expect(gateFit("bun run lint", { lint: "true" }, push)).toBeUndefined();
      const twoJobs = `${workflow}  docs:
    runs-on: ubuntu-latest
    steps:
      - run: bun run docs
`;
      const required = gateFit(
        "bun run lint",
        { lint: "true", docs: "true", "lint:licenses": "true" },
        twoJobs,
        "ci:\n  required_checks: [Checks]\n",
      );
      expect(required?.message).toContain("lint:licenses");
      expect(required?.message).not.toContain("bun run docs");
      expect(required?.message).toContain(
        "the jobs behind the required checks",
      );
      // A required job that gathers others' results stands for the jobs it needs.
      const gathered = gateFit(
        "bun run lint",
        { lint: "true", docs: "true", "lint:licenses": "true" },
        `on: pull_request
jobs:
  all:
    name: Checks
    needs: [licenses]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
  licenses:
    runs-on: ubuntu-latest
    steps:
      - run: bun run lint:licenses
  docs:
    runs-on: ubuntu-latest
    steps:
      - run: bun run docs
`,
        "ci:\n  required_checks: [Checks]\n",
      );
      expect(gathered?.message).toContain("job licenses");
      expect(gathered?.message).not.toContain("bun run docs");
    });
  });

  test("a gate program the Claude Code settings do not allow is suggested", () => {
    const permission = (command: string, allow: string[] | null) =>
      fit({
        ".config/jig.yaml": `gates:\n  command: "${command}"\n`,
        "package.json": '{"scripts":{"gates":"true"}}',
        ...(allow === null
          ? {}
          : {
              ".claude/settings.json": JSON.stringify({
                permissions: { allow },
              }),
            }),
      }).report.findings.find((f) => f.id === "suggestion:permissions.gates");
    expect(permission("pnpm run gates", ["Bash(git *)"])?.message).toContain(
      'add "Bash(pnpm *)" to permissions.allow',
    );
    for (const allow of [["Bash(pnpm *)"], ["Bash(pnpm:*)"], ["Bash"]])
      expect(permission("pnpm run gates", allow)).toBeUndefined();
    expect(permission("bun run gates", [])).toBeUndefined();
    expect(permission("pnpm run gates", null)).toBeUndefined();
    expect(
      permission("bun run gates && make check", ["Bash(git *)"])?.message,
    ).toContain('"Bash(make *)"');
  });

  test("the tracker team is suggested offline from commit subjects", () => {
    const dir = repo({ ".gitignore": ".context/\n" });
    for (const n of [1, 2, 3]) commit(dir, `feat: change ${n} (OPS-${n})`);
    const report = fitIn(dir, ["--offline"]);
    expect(
      report.suggestions.find((s) => s.field === "issue_tracker.team"),
    ).toMatchObject({
      value: "OPS",
      evidence: "OPS-<n> issue keys in 3 of the last 4 commit subjects on HEAD",
    });
  });
});
