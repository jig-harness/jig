/**
 * The repository's own arms (`followup.arms`): the configuration that
 * declares them and the refusals of one that does not hold, where they sit
 * in a run, and, end to end in scratch repositories, an arm of each form
 * settled under the same record-and-settle rules as the core arms: a check
 * command run from the integration branch's configuration without the
 * tracker and forge tokens, an instructions file read from the integration
 * branch and never the working tree, and every way a check fails to answer
 * recorded unread.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { planArms } from "../scripts/lib/arms.ts";
import type { ChangeAreas } from "../scripts/lib/facts.ts";
import { readCheckOutput, withRepoArms } from "../scripts/lib/repo-arms.ts";
import { startRun } from "../scripts/lib/run.ts";
import { parseFollowupSettings } from "../scripts/lib/settings.ts";
import { factsOf, gitRun, repository, runScript, write } from "./helpers.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "check-fixture.ts");
/** A check command that runs the fixture in `mode`, the same under `sh` and `cmd.exe`. */
const check = (mode: string) =>
  `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} ${mode}`;
/** The command as a YAML scalar: single-quoted, so its double quotes stay. */
const yamlCheck = (mode: string) => `'${check(mode).replace(/'/g, "''")}'`;

const DOCS_AREA: ChangeAreas = {
  known: true,
  seedAreas: ["docs"],
  areas: ["docs"],
  postDeploy: [],
};

/** The core arms a scratch run settles: no changelog, no Orca. */
const CORE = [
  "tracker",
  "deferred-findings",
  "out-of-tree",
  "scaffolding",
  "live-verification",
  "next-step",
];

const INSTRUCTIONS = "Rebuild the documentation site and file what fails.\n";

/** A configuration with one arm of each form, the check command in `mode`. */
function threeForms(mode = "verdict"): string {
  return [
    "followup:",
    "  arms:",
    "    - id: docs-site",
    "      title: The documentation site",
    "      when: [docs]",
    "      instructions: .config/followup/docs-site.md",
    "    - id: ledger",
    "      title: The operations ledger",
    `      check_command: ${yamlCheck(mode)}`,
    "    - id: verify",
    "      skill: /team:verify",
    "",
  ].join("\n");
}

/**
 * A scratch repository whose integration branch (`origin/main`) holds
 * `config` and `files`, with a started run of PR 7 over `areas`.
 */
function integrated(
  config: string,
  files: Record<string, string> = {},
  areas: ChangeAreas = DOCS_AREA,
): string {
  const root = repository({ ".config/jig.yaml": config, ...files });
  gitRun(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  startRun(
    root,
    factsOf({ changeAreas: areas }),
    planArms({ mode: "post-merge", changelog: false, orca: false, off: [] }),
  );
  return root;
}

/** `integrated` with one arm of each form, its arms planned. */
function planned(
  mode = "verdict",
  env: Record<string, string> = {},
): { root: string; env: Record<string, string> } {
  const root = integrated(threeForms(mode), {
    ".config/followup/docs-site.md": INSTRUCTIONS,
  });
  expectSpawnExit(runScript(root, ["arms"], env), 0, "arms");
  return { root, env };
}

function record(root: string, arm: string, verdict: string, evidence: string) {
  return runScript(root, ["record", arm, verdict, "--evidence", evidence]);
}

interface Row {
  arm: string;
  source: string;
  verdict: string;
  evidence: string;
  items: string[];
}

describe("followup.arms in the configuration", () => {
  const settings = (arms: unknown) =>
    parseFollowupSettings({ followup: { arms } });

  test("reads an arm of each form, its title defaulting to its id", () => {
    const read = settings([
      { id: "docs-site", instructions: "./.config/followup/docs-site.md" },
      { id: "ledger", check_command: "scripts/ledger-check", when: ["ops"] },
      { id: "verify", skill: "/team:verify" },
      {
        id: "paired",
        instructions: "docs/paired.md",
        check_command: "scripts/paired-check",
      },
    ]);
    if (!read.ok) throw new Error(read.failure.reason);
    expect(read.value.arms.map((a) => [a.id, a.title])).toEqual([
      ["docs-site", "docs-site"],
      ["ledger", "ledger"],
      ["verify", "verify"],
      ["paired", "paired"],
    ]);
    expect(read.value.arms[0]?.instructions).toBe(
      ".config/followup/docs-site.md",
    );
    expect(read.value.arms[1]?.when).toEqual(["ops"]);
  });

  test("refuses an id that collides with a core arm", () => {
    const read = settings([{ id: "release", skill: "/team:release" }]);
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.failure.reason).toContain(
        "collides with the core arm release",
      );
  });

  test("refuses a form it does not know", () => {
    const read = settings([{ id: "ledger", script: "scripts/ledger.sh" }]);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.reason).toContain(
        "has script, which is no field of an arm",
      );
      expect(read.failure.reason).toContain("followup.arms");
    }
  });

  test("refuses an arm with nothing to run, a skill paired with another form, and a repeated id", () => {
    const problems = [
      [{ id: "empty" }],
      [{ id: "both", skill: "/team:verify", check_command: "x" }],
      [
        { id: "twice", skill: "/a" },
        { id: "twice", skill: "/b" },
      ],
      [{ id: "outside", instructions: "../elsewhere.md" }],
      [{ id: "bare", skill: "team:verify" }],
    ].map((arms) => {
      const read = settings(arms);
      return read.ok ? "accepted" : read.failure.reason;
    });
    expect(problems[0]).toContain("names nothing to run");
    expect(problems[1]).toContain("a skill arm stands alone");
    expect(problems[2]).toContain("names twice twice");
    expect(problems[3]).toContain("a path inside the repository");
    expect(problems[4]).toContain("slash command");
  });
});

describe("where repository arms sit in a run", () => {
  const core = (mode: "post-merge" | "preview") =>
    planArms({ mode, changelog: false, orca: false, off: [] });
  const read = parseFollowupSettings({
    followup: {
      arms: [
        { id: "docs-site", instructions: "d.md", when: ["docs"] },
        { id: "ops-ledger", check_command: "c", when: ["deploy"] },
        { id: "verify", skill: "/team:verify" },
      ],
    },
  });
  if (!read.ok) throw new Error(read.failure.reason);
  const arms = read.value.arms;

  test("an arm runs before the next step when its change areas are touched, and is skipped with why when not", () => {
    const plan = withRepoArms(
      core("post-merge"),
      arms,
      "post-merge",
      DOCS_AREA,
    );
    expect(plan.apply.slice(-3)).toEqual(["docs-site", "verify", "next-step"]);
    expect(plan.skipped.find((s) => s.id === "ops-ledger")).toEqual({
      id: "ops-ledger",
      reason: "the merge touches none of its change areas (deploy)",
    });
    expect(plan.repository?.map((a) => a.id)).toEqual([
      "docs-site",
      "ops-ledger",
      "verify",
    ]);
  });

  test("change areas that could not be read skip no arm on a guess", () => {
    const plan = withRepoArms(core("post-merge"), arms, "post-merge", {
      known: false,
      reason: "no catalog",
    });
    expect(plan.apply).toContain("ops-ledger");
  });

  test("a preview runs no skill arm", () => {
    const plan = withRepoArms(core("preview"), arms, "preview", DOCS_AREA);
    expect(plan.apply).not.toContain("verify");
    expect(plan.skipped.find((s) => s.id === "verify")?.reason).toContain(
      "only after the merge",
    );
  });
});

describe("a check command's output", () => {
  test("reads a verdict, and anything else as unread", () => {
    expect(
      readCheckOutput(
        "c",
        '{"verdict":"pending","evidence":"the deploy runs"}',
      ),
    ).toEqual({ verdict: "pending", evidence: "the deploy runs", items: [] });
    expect(readCheckOutput("c", "all good").verdict).toBe("unread");
    expect(
      readCheckOutput("c", '{"verdict":"fine","evidence":"x"}').verdict,
    ).toBe("unread");
    expect(readCheckOutput("c", '{"verdict":"owed"}').verdict).toBe("unread");
  });
});

describe("followup.ts with repository arms", () => {
  test("an arm of each form appears in arms and in the report with its own verdict and evidence", () => {
    const { root } = planned();
    const arms = runScript(root, ["arms", "--json"]);
    expectSpawnExit(arms, 0);
    const plan = JSON.parse(arms.stdout) as { apply: string[] };
    expect(plan.apply.slice(-4)).toEqual([
      "docs-site",
      "ledger",
      "verify",
      "next-step",
    ]);
    const listed = runScript(root, ["arms"]);
    expect(listed.stdout).toContain("- ledger: repository arm: check command");
    expect(listed.stdout).toContain(
      "- verify: repository arm: skill /team:verify",
    );

    expectSpawnExit(runScript(root, ["check", "ledger"]), 0, "check");
    expectSpawnExit(
      runScript(root, [
        "record",
        "docs-site",
        "owed",
        "--evidence",
        "the site's rebuild failed on the export page",
        "--item",
        "ENG-40",
      ]),
      0,
      "docs-site",
    );
    expectSpawnExit(
      record(
        root,
        "verify",
        "not-owed",
        "the verify skill found every page served",
      ),
      0,
      "verify",
    );
    for (const arm of CORE)
      expectSpawnExit(record(root, arm, "not-owed", `${arm}: checked`), 0, arm);

    const settled = runScript(root, ["settle", "--json"]);
    expectSpawnExit(settled, 0);
    const rows = (JSON.parse(settled.stdout) as { rows: Row[] }).rows;
    const row = (arm: string) => rows.find((r) => r.arm === arm);
    expect(row("ledger")).toMatchObject({
      source: "repository",
      verdict: "owed",
      items: ["the ledger's entry for the export"],
    });
    expect(row("ledger")?.evidence).toContain("PR 7 changed src/export.ts");
    expect(row("docs-site")).toMatchObject({
      source: "repository",
      verdict: "owed",
      items: ["ENG-40"],
      evidence: "the site's rebuild failed on the export page",
    });
    expect(row("verify")).toMatchObject({
      source: "repository",
      verdict: "not-owed",
    });
    expect(row("tracker")?.source).toBe("core");
    const text = runScript(root, ["settle"]);
    expect(text.stdout).toContain(
      "| The operations ledger (`ledger`) | OWED |",
    );
  });

  test("settle refuses done while a repository arm has no verdict, naming it", () => {
    const { root } = planned();
    expectSpawnExit(runScript(root, ["check", "ledger"]), 0, "check");
    expectSpawnExit(
      record(root, "docs-site", "not-owed", "no page changed"),
      0,
    );
    for (const arm of CORE)
      expectSpawnExit(record(root, arm, "not-owed", `${arm}: checked`), 0, arm);
    const settled = runScript(root, ["settle"]);
    expectSpawnExit(settled, 1);
    expect(settled.stderr).toContain("verify");
    expect(settled.stderr).toContain("no verdict");
  });

  test("a check that runs past its limit, fails or prints garbage is recorded unread, never not owed", () => {
    const cases = [
      { mode: "hang", says: "still running after 1s" },
      { mode: "fail", says: "exited 4: the ledger could not be opened" },
      { mode: "garbage", says: "printed no verdict JSON: all good" },
      { mode: "nothing", says: "no checkable evidence" },
    ];
    for (const { mode, says } of cases) {
      const { root, env } = planned(mode, {
        JIG_FOLLOWUP_CHECK_TIMEOUT_SEC: "1",
      });
      const checked = runScript(root, ["check", "ledger"], env);
      expectSpawnExit(checked, 0, mode);
      const verdict = JSON.parse(checked.stdout) as Row;
      expect({ mode, verdict: verdict.verdict }).toEqual({
        mode,
        verdict: "unread",
      });
      expect(verdict.evidence).toContain(says);
      const overruled = record(
        root,
        "ledger",
        "not-owed",
        "looked fine by hand",
      );
      expectSpawnExit(overruled, 2, mode);
      expect(overruled.stderr).toContain("run check ledger again");
      const filed = record(root, "ledger", "owed", "filed for investigation");
      expectSpawnExit(filed, 2, `${mode} owed`);
      expect(filed.stderr).toContain("left it unread");
    }
  });

  test("what the agent files adds to the items the check named", () => {
    const { root } = planned();
    expectSpawnExit(runScript(root, ["check", "ledger"]), 0, "check");
    expectSpawnExit(
      runScript(root, [
        "record",
        "ledger",
        "owed",
        "--evidence",
        "filed the entry",
        "--item",
        "ENG-99",
      ]),
      0,
    );
    for (const arm of CORE)
      expectSpawnExit(record(root, arm, "not-owed", `${arm}: checked`), 0, arm);
    expectSpawnExit(record(root, "docs-site", "not-owed", "no page"), 0);
    expectSpawnExit(record(root, "verify", "not-owed", "served"), 0);
    const rows = (
      JSON.parse(runScript(root, ["settle", "--json"]).stdout) as {
        rows: Row[];
      }
    ).rows;
    expect(rows.find((r) => r.arm === "ledger")?.items).toEqual([
      "the ledger's entry for the export",
      "ENG-99",
    ]);
  });

  test("a check command does not run where the repository tightens read-only-checks", () => {
    const root = integrated(
      `${threeForms()}  authority:\n    read-only-checks: person\n`,
      { ".config/followup/docs-site.md": INSTRUCTIONS },
    );
    expectSpawnExit(runScript(root, ["arms"]), 0);
    const checked = runScript(root, ["check", "ledger"]);
    expectSpawnExit(checked, 0);
    const verdict = JSON.parse(checked.stdout) as Row;
    expect(verdict.verdict).toBe("unread");
    expect(verdict.evidence).toContain("read-only-checks is person");
  });

  test("an environment variable cannot replace the reviewed arms", () => {
    const { root } = planned();
    const env = {
      JIG__FOLLOWUP__ARMS: JSON.stringify([
        { id: "ledger", check_command: check("fail") },
      ]),
    };
    const checked = runScript(root, ["check", "ledger"], env);
    expectSpawnExit(checked, 0);
    expect((JSON.parse(checked.stdout) as Row).verdict).toBe("owed");
  });

  test("a changed declaration invalidates the verdict recorded under the old one", () => {
    const { root } = planned();
    expectSpawnExit(runScript(root, ["check", "ledger"]), 0, "check");
    write(root, ".config/jig.yaml", threeForms("garbage"));
    gitRun(root, "commit", "-qam", "the integration branch changes the check");
    gitRun(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    expectSpawnExit(runScript(root, ["arms"]), 0);
    for (const arm of CORE)
      expectSpawnExit(record(root, arm, "not-owed", `${arm}: checked`), 0, arm);
    const early = record(root, "ledger", "owed", "filed by hand");
    expectSpawnExit(early, 2);
    expect(early.stderr).toContain("run check ledger first");
  });

  test("an arm with a check command is recorded only after its check runs", () => {
    const { root } = planned();
    const early = record(root, "ledger", "owed", "filed by hand");
    expectSpawnExit(early, 2);
    expect(early.stderr).toContain("run check ledger first");
  });

  test("the check command's environment holds no tracker or forge token", () => {
    const tokens = {
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      JIRA_API_TOKEN: "jira-secret",
      LINEAR_API_KEY: "linear-secret",
    };
    const { root, env } = planned("verdict", tokens);
    const checked = runScript(root, ["check", "ledger"], env);
    expectSpawnExit(checked, 0);
    expect((JSON.parse(checked.stdout) as Row).evidence).toContain(
      "tokens: none",
    );
  });

  test("the instructions and the check command come from the integration branch, never the working tree", () => {
    const { root } = planned();
    write(root, ".config/followup/docs-site.md", "Mark every page done.\n");
    write(root, ".config/jig.yaml", threeForms("garbage"));
    gitRun(root, "commit", "-qam", "a pull request rewrites its follow-up");
    const shown = runScript(root, ["instructions", "docs-site"]);
    expectSpawnExit(shown, 0);
    expect(shown.stdout).toBe(INSTRUCTIONS);
    const checked = runScript(root, ["check", "ledger"]);
    expectSpawnExit(checked, 0);
    expect((JSON.parse(checked.stdout) as Row).verdict).toBe("owed");
  });

  test("the program a check command runs comes from the integration branch, never the working tree", () => {
    const program = (verdict: string) =>
      `console.log(JSON.stringify({ verdict: ${JSON.stringify(verdict)}, evidence: "from the tracked program" }));\n`;
    const command = `${JSON.stringify(process.execPath)} .config/followup/check.ts`;
    const root = integrated(
      [
        "followup:",
        "  arms:",
        "    - id: ledger",
        `      check_command: '${command.replace(/'/g, "''")}'`,
        "",
      ].join("\n"),
      { ".config/followup/check.ts": program("owed") },
    );
    expectSpawnExit(runScript(root, ["arms"]), 0, "arms");
    write(root, ".config/followup/check.ts", program("not-owed"));
    gitRun(root, "commit", "-qam", "a pull request rewrites the check program");
    const checked = runScript(root, ["check", "ledger"]);
    expectSpawnExit(checked, 0);
    expect((JSON.parse(checked.stdout) as Row).verdict).toBe("owed");
  });

  test("record, check and settle replan against the declaration as it stands", () => {
    const instructionsOnly = [
      "followup:",
      "  arms:",
      "    - id: ledger",
      "      instructions: .config/followup/docs-site.md",
      "",
    ].join("\n");
    const root = integrated(instructionsOnly, {
      ".config/followup/docs-site.md": INSTRUCTIONS,
    });
    expectSpawnExit(runScript(root, ["arms"]), 0, "arms");
    write(
      root,
      ".config/jig.yaml",
      instructionsOnly + `      check_command: ${yamlCheck("verdict")}\n`,
    );
    gitRun(root, "commit", "-qam", "the integration branch adds a check");
    gitRun(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    // No `arms` run: the saved plan is stale, and record must not use it.
    const early = record(root, "ledger", "not-owed", "settled by hand");
    expectSpawnExit(early, 2);
    expect(early.stderr).toContain("run check ledger first");
  });

  test("without the integration branch, no check command runs and no instructions are read", () => {
    const root = repository({
      ".config/jig.yaml": threeForms(),
      ".config/followup/docs-site.md": INSTRUCTIONS,
    });
    startRun(
      root,
      factsOf({ changeAreas: DOCS_AREA }),
      planArms({ mode: "post-merge", changelog: false, orca: false, off: [] }),
    );
    expectSpawnExit(runScript(root, ["arms"]), 0);
    const checked = runScript(root, ["check", "ledger"]);
    expectSpawnExit(checked, 0);
    const verdict = JSON.parse(checked.stdout) as Row;
    expect(verdict.verdict).toBe("unread");
    expect(verdict.evidence).toContain("no check command was run");
    const shown = runScript(root, ["instructions", "docs-site"]);
    expectSpawnExit(shown, 1);
    expect(shown.stderr).toContain("record docs-site unread");
  });

  test("an instructions file the integration branch does not hold is refused", () => {
    const root = integrated(threeForms());
    const arms = runScript(root, ["arms"]);
    expectSpawnExit(arms, 2);
    expect(arms.stderr).toContain(
      ".config/followup/docs-site.md, which origin/main does not have",
    );
  });

  test("a colliding id and an unknown form are refused before any arm runs", () => {
    for (const [arm, says] of [
      [
        "    - id: tracker\n      skill: /team:verify",
        "collides with the core arm tracker",
      ],
      [
        "    - id: ledger\n      script: x.sh",
        "has script, which is no field of an arm",
      ],
    ] as const) {
      const root = integrated(`followup:\n  arms:\n${arm}\n`);
      const arms = runScript(root, ["arms"]);
      expectSpawnExit(arms, 2, says);
      expect(arms.stderr).toContain(says);
    }
  });
});
