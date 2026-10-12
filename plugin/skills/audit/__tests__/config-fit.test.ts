import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandProblems, commandSegments } from "../scripts/config-fit.ts";
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
      { number: 7, baseRefName: "main" },
      { number: 8, baseRefName: "eng-7-change" },
    ]),
    "label list": JSON.stringify([{ name: "agent-authored" }]),
    ...over,
  });

  function online(config: string, over?: Record<string, string>) {
    const dir = repo({ ".config/jig.yaml": config });
    const bin = fakeGh(dir, answers(over));
    const env = cleanEnv({ PATH: withPath(bin) });
    const run = runScript("config-fit.ts", ["--json"], dir, env);
    if (run.code === 2) throw new Error(run.err);
    return JSON.parse(run.out) as Report;
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
    expect(report.facts.branch_protection).toBe("requires no checks");
    expect(ids(report)).toContain("fact:no-required-checks");
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
    expect(ids(report)).toContain("fact:environment-layer");
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

  test("a tracker without credentials cannot be reached", () => {
    const dir = repo({
      ".config/jig.yaml":
        "repository:\n  base_branch: main\nissue_tracker:\n  team: ENG\n",
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
});
