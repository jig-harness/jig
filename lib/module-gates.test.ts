import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  corpus,
  formula,
  gates,
  hasReference,
  normalizeThreads,
  parity,
  prTargetSafety,
  requiredSections,
  reflection,
  roundConverged,
  stageAccepted,
  threadsResolved,
} from "./module-gates.ts";
const root = join(import.meta.dir, "..");
const m6 = join(root, "modules/M6-feature-delivery-pipeline/reference");
const m7 = join(root, "modules/M7-pr-lifecycle-review/reference");
const m8 = join(root, "modules/M8-learning-loop/reference");
const m9 = join(root, "modules/M9-tasks-memory/reference");
const temps: string[] = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "module-gates-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const fixture = (module: string, gate: string, name: string) =>
  join(module, gate, "fixtures", name);
test("required headings accept environment, case, and diagnose missing headings and inputs", () => {
  const good = fixture(m6, "required-sections", "good-prd.md"),
    bad = fixture(m6, "required-sections", "bad-prd.md");
  for (const sections of [
    "Problem statement|Success metrics",
    "PROBLEM STATEMENT|success metrics",
  ])
    expect(requiredSections([good], { SECTIONS: sections }).code).toBe(0);
  expect(
    requiredSections([bad], { SECTIONS: "Problem statement|Success metrics" })
      .code,
  ).toBe(1);
  expect(
    requiredSections(
      [bad, fixture(m6, "required-sections", "sections.txt")],
      {},
    ).stdout,
  ).toMatch(/MISSING required section.*Success metrics/);
  for (const [args, env] of [
    [[], {}],
    [[good], {}],
    [[good, "missing"], {}],
    [[good, fixture(m6, "required-sections", "empty-sections.txt")], {}],
  ] as [string[], Record<string, string>][])
    expect(requiredSections(args, env).code).toBe(2);
});
test("stage records diagnose usage and explain how to supply a review", () => {
  expect(stageAccepted([], {}).code).toBe(2);
  expect(
    stageAccepted(
      [fixture(m6, "stage-review-record", "accepted-no-review.md")],
      {},
    ).stdout,
  ).toMatch(/reviewed:.*or a non-empty ## Review/);
});
test("thread diagnostics preserve declared-state vocabulary and per-row trail failures", () => {
  const output = threadsResolved(
    [fixture(m7, "comment-resolution", "unclassified.txt")],
    {},
  ).stdout;
  expect(output).toContain("declares no verdict");
  expect(output).not.toContain("unknown state");
  expect(
    threadsResolved([fixture(m7, "comment-resolution", "unknown.txt")], {})
      .stdout,
  ).toContain(
    "unknown state 'resolveed' (want: addressed|rejected|deferred|moot)",
  );
  expect(
    threadsResolved([fixture(m7, "comment-resolution", "clean.txt")], {})
      .stdout,
  ).not.toContain("T-1003");
  for (const row of ["T-6101", "T-6102"])
    expect(
      threadsResolved(
        [fixture(m7, "comment-resolution", "bad-ref-deferred.txt")],
        {},
      ).stdout,
    ).toContain(`FAIL ${row}`);
});
test("audit references cannot be English hex words or token substrings", () => {
  for (const trail of ["defaced", "commit defacedly", "later", "x"])
    expect(hasReference(trail)).toBe(false);
  for (const trail of [
    "commit defaced",
    "sha: deadbeef",
    "(a1b2c3d)",
    "`a1b2c3d`",
    "a1b2c3d.",
    "#123",
    "ISSUE-482",
    "https://example.com/pr/1",
  ])
    expect(hasReference(trail)).toBe(true);
});
test("normalizer anchors encodings, accepts synonyms and selects newest declared verdict", () => {
  const dir = temporary(),
    rows = join(dir, "rows.tsv");
  const cases = [
    ["token", "This is intended — rejected upstream years ago", "unclassified"],
    ["trailer", "**accepted** — added the guard in a1b2c3d", "unclassified"],
    ["token", "added the guard in a1b2c3d. Verdict: accepted", "unclassified"],
    ["token", "**accepted** — added the guard in a1b2c3d", "addressed"],
    ["token", "obsolete: the helper went away in 4f5a6b7", "moot"],
  ];
  for (const [encoding = "", body = "", state = ""] of cases) {
    writeFileSync(rows, `T-1\ttrue\t${body}\n`);
    expect(
      normalizeThreads([rows], { VERDICT_ENCODING: encoding })
        .stdout.trim()
        .split(/\s+/)[1],
    ).toBe(state);
  }
  for (const [body, state] of [
    [
      "T-1\ttrue\t**accepted** — fixed in a1b2c3d\nT-1\ttrue\t**rejected** — actually intended\n",
      "addressed",
    ],
    ["T-1\tfalse\t**accepted** — fixed in a1b2c3d\n", "open"],
    ["T-1\ttrue\tsounds good\nT-1\ttrue\tthanks for looking\n", "unclassified"],
  ]) {
    writeFileSync(rows, body || "");
    expect(normalizeThreads([rows], {}).stdout.trim().split(/\s+/)[1]).toBe(
      state,
    );
  }
  expect(normalizeThreads([rows], { VERDICT_ENCODING: "sniffing" }).code).toBe(
    2,
  );
  // Export and merge-gate must agree: decoding alone is insufficient evidence.
  for (const [name, encoding, code] of [
    ["token", "token", 0],
    ["trailer", "trailer", 0],
    ["undeclared", "token", 1],
    ["open", "token", 1],
    ["verdict-then-ack", "token", 1],
  ] as const) {
    const exported = normalizeThreads(
      [fixture(m7, "comment-resolution", `raw/${name}.tsv`)],
      { VERDICT_ENCODING: encoding },
    );
    expect(exported.code).toBe(0);
    writeFileSync(rows, exported.stdout);
    expect(threadsResolved([rows], {}).code).toBe(code);
  }
});
test("round decisions preserve precedence, identities, pending names and machine-readable measurement", () => {
  for (const [name, decision] of [
    ["reviewer-pending.txt", "WAIT"],
    ["converged.txt", "CONVERGED"],
    ["pr-merged.txt", "ABORT"],
    ["work-before-wait.txt", "WORK"],
    ["double-counted-bot.txt", "WAIT"],
  ])
    expect(
      roundConverged(
        [fixture(m7, "review-convergence", name || "")],
        {},
      ).stdout.startsWith(decision || ""),
    ).toBe(true);
  expect(
    roundConverged(
      [fixture(m7, "review-convergence", "double-counted-bot.txt")],
      {},
    ).stdout,
  ).toContain("reviewers=1/2");
  expect(
    roundConverged(
      [fixture(m7, "review-convergence", "reviewer-pending.txt")],
      {},
    ).stderr,
  ).toContain("still pending: alice");
  expect(
    roundConverged([fixture(m7, "review-convergence", "converged.txt")], {})
      .stdout,
  ).toMatch(/^CONVERGED round=3 .*reviewers=2\/2/);
});
test("workflow directory scanning fails closed when directory is unreadable", () => {
  expect(
    prTargetSafety([], {
      WORKFLOWS_DIR: fixture(m7, "pr-target-safety", "safe"),
    }).code,
  ).toBe(0);
  expect(
    prTargetSafety([], {
      WORKFLOWS_DIR: fixture(m7, "pr-target-safety", "unsafe"),
    }).code,
  ).toBe(1);
  expect(
    prTargetSafety([], {
      WORKFLOWS_DIR: fixture(m7, "pr-target-safety", "none"),
    }).code,
  ).toBe(0);
  const dir = temporary();
  writeFileSync(join(dir, "wf.yml"), "on: push\n");
  chmodSync(dir, 0);
  try {
    if (process.getuid?.() !== 0 && process.platform !== "win32")
      expect(prTargetSafety([], { WORKFLOWS_DIR: dir }).code).toBe(2);
  } finally {
    chmodSync(dir, 0o755);
  }
});
test("parity thresholds validate boundaries and retain promotion arithmetic", () => {
  const tally = fixture(m8, "parity-report", "clean.tsv");
  for (const minimum of ["-1", "1.5", "high"])
    expect(parity([tally], { MIN_PRECISION: minimum }).code).toBe(2);
  expect(parity([tally], { MIN_PRECISION: "1" }).code).toBe(0);
  const out = parity([tally], {}).stdout;
  expect(out).toMatch(/shadow.*promotable=yes/);
  expect(out).toMatch(/vendor-bot.*promotable=no/);
});
test("formula rejects malformed definitions and honors caller-selected done states", () => {
  const record = fixture(m9, "required-phases", "good/closed-complete.txt");
  for (const bad of ["empty-formula.yaml", "duplicate-required.yaml"])
    expect(
      formula([record, fixture(m9, "required-phases", `bad/${bad}`)], {}).code,
    ).toBe(2);
  expect(
    formula([fixture(m9, "required-phases", "good/shipped-incomplete.txt")], {
      FORMULA: fixture(m9, "required-phases", "formula.yaml"),
      DONE_STATES: "shipped",
    }).code,
  ).toBe(1);
});
test("all command functions report missing files and support original environment inputs", async () => {
  for (const [name, gate] of Object.entries(gates)) {
    if (name === "check-pr-target-safety") continue;
    expect((await gate(["missing-file"], {})).code).toBe(2);
  }
  expect(
    corpus([fixture(m8, "corpus-lint", "good/corpus.yaml")], {
      TAXONOMY: "missing",
    }).code,
  ).toBe(2);
  expect(
    stageAccepted([], {
      ARTIFACT: fixture(m6, "stage-review-record", "draft.md"),
    }).code,
  ).toBe(0);
});
const written = (name: string, body: string) => {
  const path = join(temporary(), name);
  writeFileSync(path, body);
  return path;
};
test("thread states and verdict words ignore inherited object properties", () => {
  for (const state of ["constructor", "__proto__", "toString"]) {
    const result = threadsResolved(
      [written("states.txt", `T-1 ${state} see a1b2c3d\n`)],
      {},
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`unknown state '${state}'`);
    const rows = written("rows.tsv", `T-1\ttrue\t${state} fixed in a1b2c3d\n`);
    expect(normalizeThreads([rows], {}).stdout).toStartWith("T-1 unclassified");
  }
});
test("workflow lint reads flow-mapping refs and fails closed on bad directory input", () => {
  const dir = temporary();
  const expr = (body: string) => `\${{ ${body} }}`;
  for (const checkout of [
    `with: { ref: '${expr("github.event.pull_request.head.sha")}' }`,
    `with: { path: x, repository: ${expr("github.event.pull_request.head.repo.full_name")} }`,
    `with: {"ref": "${expr("github.head_ref")}"}`,
  ]) {
    const workflow = written(
      "wf.yml",
      `on: pull_request_target\njobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n        ${checkout}\n      - run: make test\n`,
    );
    expect(prTargetSafety([workflow], {}).code).toBe(1);
  }
  const flowCheckout = `      - uses: actions/checkout@v4\n        with: { ref: \${{ github.event.pull_request.head.sha }} }\n`;
  for (const step of [
    "      - { run: make test }\n",
    "      - { name: build, run: make test }\n",
    '      - { "run": "make test" }\n',
    "      - { uses: ./.github/actions/x }\n",
    "      - { name: x, uses: './.github/actions/x' }\n",
  ])
    expect(
      prTargetSafety(
        [
          written(
            "flow.yml",
            `on: pull_request_target\njobs:\n  j:\n    steps:\n${flowCheckout}${step}`,
          ),
        ],
        {},
      ).code,
    ).toBe(1);
  for (const step of [
    "      - { uses: actions/setup-node@v4 }\n",
    "      # - { run: make test }\n",
  ])
    expect(
      prTargetSafety(
        [
          written(
            "flow-safe.yml",
            `on: pull_request_target\njobs:\n  j:\n    steps:\n${flowCheckout}${step}`,
          ),
        ],
        {},
      ).code,
    ).toBe(0);
  const safe = written(
    "safe.yml",
    "on: pull_request_target\njobs:\n  j:\n    steps:\n      - uses: actions/checkout@v4\n        with: { ref: main }\n      - run: make test\n",
  );
  expect(prTargetSafety([safe], {}).code).toBe(0);
  expect(prTargetSafety([], { WORKFLOWS_DIR: safe }).code).toBe(2);
  expect(prTargetSafety([], { WORKFLOWS_DIR: join(safe, "nested") }).code).toBe(
    0,
  );
  const locked = join(dir, "locked");
  mkdirSync(join(locked, "workflows"), { recursive: true });
  chmodSync(locked, 0);
  try {
    if (process.getuid?.() !== 0 && process.platform !== "win32")
      expect(
        prTargetSafety([], { WORKFLOWS_DIR: join(locked, "workflows") }).code,
      ).toBe(2);
  } finally {
    chmodSync(locked, 0o755);
  }
});
test("review heading needs a boundary after Review", () => {
  const artifact = (heading: string) =>
    written(
      "doc.md",
      `---\nstatus: accepted\n---\n\n# Doc\n\n${heading}\n\nSome content.\n`,
    );
  for (const heading of ["## Reviewability", "## Reviewer backlog"])
    expect(stageAccepted([artifact(heading)], {}).code).toBe(1);
  for (const heading of ["## Review", "## Review: round 2", "## Review (2026)"])
    expect(stageAccepted([artifact(heading)], {}).code).toBe(0);
});
test("formula rejects record lines that are neither status nor a phase id", () => {
  const formulaPath = fixture(m9, "required-phases", "formula.yaml");
  const record = (body: string) => written("record.txt", body);
  for (const body of [
    "status: done\narchitect-review\nstaging-verify\nnotes: research was not performed\n",
    "status: done\narchitect-review\nstaging-verify\nnot run yet\n",
    "status: done\narchitect-review\nstaging-verify\nphase:\n",
  ])
    expect(formula([record(body)], { FORMULA: formulaPath }).code).toBe(2);
  expect(
    formula(
      [
        record(
          "# export\nstatus: 'done'\n- architect-review\nphase: staging-verify # ok\n",
        ),
      ],
      { FORMULA: formulaPath },
    ).code,
  ).toBe(0);
});
test("corpus rejects malformed collections and duplicate fixture fields", () => {
  const taxonomy = join(m8, "../templates/miss-taxonomy.yaml");
  const run = (body: string) =>
    corpus([written("corpus.yaml", body)], { TAXONOMY: taxonomy });
  const entry =
    "  - lever: L-0001\n    category: test-gap\n    pinned_commit: abc1234\n    lens: LENS-001\n";
  for (const declaration of [
    "fixtures: disabled\n",
    "fixtures: { lever: L-0001 }\n",
    "fixtures:\n  lever: L-0001\n",
  ])
    expect(run(`version: 1\n${declaration}`).code).toBe(2);
  expect(run("version: 1\nfixtures: []\n").code).toBe(0);
  expect(run("version: 1\nfixtures: # none yet\n").code).toBe(0);
  expect(run(`version: 1\nfixtures:\n${entry}    required: false\n`).code).toBe(
    0,
  );
  const second = entry.replace("L-0001", "L-0002");
  for (const stray of ["  bogus: ignored\n", " bogus: ignored\n"]) {
    const rejected = run(
      `version: 1\nfixtures:\n${entry}    required: false\n${stray}`,
    );
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("must hold only '- ' entries");
    expect(run(`version: 1\nfixtures:\n${entry}${second}${stray}`).code).toBe(
      2,
    );
  }
  for (const accepted of [
    "    title: a continuation field\n",
    "    notes:\n      - nested item\n",
    "\n# a comment\n",
    "other_key: 1\n",
  ])
    expect(
      run(`version: 1\nfixtures:\n${entry}${accepted}${second}`).code,
    ).toBe(0);
  const withoutLens =
    "  - lever: L-0001\n    category: test-gap\n    pinned_commit: abc1234\n";
  for (const nested of [
    "    notes:\n      - lens: LENS-001\n",
    "    notes:\n    - lens: LENS-001\n",
    "    notes:\n      lens: LENS-001\n",
    "    notes:\n      - lever: L-0009\n        lens: LENS-001\n",
  ]) {
    const missingLens = run(
      `version: 1\nfixtures:\n${withoutLens}${nested}    required: false\n`,
    );
    expect(missingLens.code).toBe(1);
    expect(missingLens.stdout).toContain("missing lens");
  }
  const nestedFields = run(
    `version: 1\nfixtures:\n${entry}    required: false\n    notes:\n      lever: L-0009\n      - category: other\n      required: true\n      lens: LENS-009\n`,
  );
  expect(nestedFields.code).toBe(0);
  expect(nestedFields.stdout).toContain("FIX L-0001");
  expect(
    run(
      `version: 1\nfixtures:\n${entry}    required: true\n    notes:\n      validated:\n        date: 2026-05-12\n`,
    ).code,
  ).toBe(1);
  expect(
    run(
      `version: 1\nfixtures:\n${entry}    required: true\n    validated:\n      date: 2026-05-12\n`,
    ).code,
  ).toBe(0);
  const duplicate = run(
    `version: 1\nfixtures:\n${entry}    required: true\n    required: false\n`,
  );
  expect(duplicate.code).toBe(1);
  expect(duplicate.stdout).toContain("duplicate 'required:' field");
  expect(run(`version: 1\nfixtures:\n${entry}    lens: LENS-002\n`).code).toBe(
    1,
  );
});
const trigger = join(m8, "reflection-trigger/reflection-trigger.ts");
const hard = fixture(m8, "reflection-trigger", "converged-hard.txt");
const reflectionCli = (
  args: string[],
  env: Record<string, string | undefined>,
) =>
  Bun.spawnSync([process.execPath, trigger, ...args], {
    env: { ...process.env, ...env },
  });
const setupInbox = () => {
  const dir = temporary(),
    inbox = join(dir, "inbox.md");
  writeFileSync(inbox, "# Reflection inbox\n");
  return { dir, inbox, env: { CHANGE: "PR-482", INBOX: inbox } };
};
test("reflection threshold and required configuration errors", () => {
  const { inbox, env } = setupInbox();
  for (const [threshold, code] of [
    ["6", 3],
    ["5", 0],
    ["0", 2],
  ] as const)
    expect(
      reflectionCli([hard], { ...env, ROUND_THRESHOLD: threshold }).exitCode,
    ).toBe(code);
  for (const bad of [
    { CHANGE: "" },
    { INBOX: "" },
    { CHANGE: "the auth PR" },
    { INBOX: `${inbox}missing` },
    { ARCHIVE: `${inbox}missing` },
    { LOCK_TIMEOUT: "-1" },
  ])
    expect(reflectionCli([hard], { ...env, ...bad }).exitCode).toBe(2);
});
test("reflection records measurement, re-prompts placeholders, skips completion, extends census through archive", () => {
  const { dir, inbox, env } = setupInbox();
  expect(reflectionCli([hard], env).exitCode).toBe(0);
  for (const pattern of [
    /^- change: PR-482$/m,
    /^- rounds: 5$/m,
    /^- levers:/m,
    /^- disposition:/m,
  ])
    expect(readFileSync(inbox, "utf8")).toMatch(pattern);
  expect(reflectionCli([hard], env).exitCode).toBe(0);
  expect(readFileSync(inbox, "utf8").match(/^- change:/gm)?.length).toBe(1);
  writeFileSync(
    inbox,
    readFileSync(inbox, "utf8").replace(
      /^- disposition: <.*$/m,
      "- disposition: L-0042",
    ),
  );
  expect(reflectionCli([hard], env).exitCode).toBe(3);
  const round7 = join(dir, "round7.txt");
  writeFileSync(
    round7,
    "CONVERGED round=7 open_threads=0 reviewers=2/2 pr_state=open\n",
  );
  expect(reflectionCli([round7], env).exitCode).toBe(0);
  expect(readFileSync(inbox, "utf8").match(/^- change:/gm)?.length).toBe(2);
  const archive = join(dir, "archive.md");
  writeFileSync(archive, readFileSync(inbox, "utf8"));
  writeFileSync(inbox, "# Reflection inbox\n");
  expect(reflectionCli([hard], { ...env, ARCHIVE: archive }).exitCode).toBe(3);
  expect(reflectionCli([hard], env).exitCode).toBe(0);
});
test("eight concurrent reflection invocations write exactly one record and release lock", async () => {
  const { inbox, env } = setupInbox();
  const runs = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, trigger, hard], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    runs.map(async (run) => ({
      code: await run.exited,
      stderr: await new Response(run.stderr).text(),
    })),
  );
  const diagnostics = results.map(({ code, stderr }) => ({
    code,
    stderr: code === 0 ? "" : stderr,
  }));
  expect(diagnostics).toEqual(results.map(() => ({ code: 0, stderr: "" })));
  expect(readFileSync(inbox, "utf8").match(/^- change:/gm)?.length).toBe(1);
  expect(existsSync(`${inbox}.lock`)).toBe(false);
}, 15000);
test("stale locks fail bounded with a recovery instruction, while foreign lock paths survive", () => {
  const { inbox, env } = setupInbox();
  if (process.platform === "win32")
    writeFileSync(`${inbox}.lock`, "jig-reflection-lock-v1 999999999 stale\n");
  else symlinkSync("999999999", `${inbox}.lock`);
  const run = reflectionCli([hard], { ...env, LOCK_TIMEOUT: "1" });
  expect(run.exitCode).toBe(2);
  expect(run.stderr.toString()).toContain(`rm -f ${inbox}.lock`);
  expect(readFileSync(inbox, "utf8")).not.toContain("- change:");
  unlinkSync(`${inbox}.lock`);
  expect(reflectionCli([hard], env).exitCode).toBe(0);
  for (const directory of [false, true]) {
    const lock = `${inbox}.lock`;
    if (directory) require("node:fs").mkdirSync(lock);
    else writeFileSync(lock, "foreign");
    expect(reflectionCli([hard], { ...env, LOCK_TIMEOUT: "1" }).exitCode).toBe(
      2,
    );
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
  }
}, 5000);
test.skipIf(process.platform === "win32")(
  "reflection writes through symlink inbox and preserves mode on replacement",
  () => {
    const { dir, inbox, env } = setupInbox();
    const link = join(dir, "link.md");
    symlinkSync("inbox.md", link);
    chmodSync(inbox, 0o664);
    expect(reflectionCli([hard], { ...env, INBOX: link }).exitCode).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(inbox, "utf8")).toContain("- change: PR-482");
    if (process.platform !== "win32")
      expect(statSync(inbox).mode & 0o777).toBe(0o664);
  },
);

test("Windows owner-file protocol publishes complete ownership and preserves stale and foreign files", async () => {
  const { dir, inbox, env } = setupInbox();
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () => reflection([hard], env, "win32")),
  );
  expect(outcomes.every((run) => run.code === 0)).toBe(true);
  expect(readFileSync(inbox, "utf8").match(/^- change:/gm)?.length).toBe(1);
  expect(existsSync(`${inbox}.lock`)).toBe(false);
  expect(
    require("node:fs")
      .readdirSync(dir)
      .some((name: string) => name.includes(".owner.")),
  ).toBe(false);
  writeFileSync(`${inbox}.lock`, "jig-reflection-lock-v1 999999999 stale\n");
  const stale = await reflection(
    [hard],
    { ...env, LOCK_TIMEOUT: "0" },
    "win32",
  );
  expect(stale.code).toBe(2);
  expect(stale.stderr).toContain("stale lock:");
  expect(readFileSync(`${inbox}.lock`, "utf8")).toContain("999999999");
  unlinkSync(`${inbox}.lock`);
  writeFileSync(`${inbox}.lock`, "foreign data");
  const foreign = await reflection(
    [hard],
    { ...env, LOCK_TIMEOUT: "0" },
    "win32",
  );
  expect(foreign.code).toBe(2);
  expect(foreign.stderr).toContain("refusing to remove it");
  expect(readFileSync(`${inbox}.lock`, "utf8")).toBe("foreign data");
}, 15000);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "Windows owner-file protocol retries while the lock is briefly unreadable, without spending the timeout",
  async () => {
    const { inbox, env } = setupInbox();
    const lock = `${inbox}.lock`;
    writeFileSync(lock, "jig-reflection-lock-v1 999999999 stale\n");
    chmodSync(lock, 0);
    const pending = reflection([hard], { ...env, LOCK_TIMEOUT: "0" }, "win32");
    await Bun.sleep(200);
    unlinkSync(lock);
    const outcome = await pending;
    expect({
      code: outcome.code,
      stderr: outcome.code === 0 ? "" : outcome.stderr,
    }).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(inbox, "utf8").match(/^- change:/gm)?.length).toBe(1);
    expect(existsSync(lock)).toBe(false);
  },
  5000,
);
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "Windows owner-file protocol gives up with a clear error when the lock stays unreadable",
  async () => {
    const { inbox, env } = setupInbox();
    const lock = `${inbox}.lock`;
    writeFileSync(lock, "jig-reflection-lock-v1 999999999 stale\n");
    chmodSync(lock, 0);
    // Every retry, with a 1ms pause instead of the production 25ms.
    const outcome = await reflection(
      [hard],
      { ...env, REFLECTION_LOCK_RETRY_MS: "1" },
      "win32",
    );
    chmodSync(lock, 0o644);
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("stayed unreadable");
  },
  20000,
);

test("reflection accepts CRLF exported records", async () => {
  const { dir, env } = setupInbox();
  const record = join(dir, "decision.txt");
  writeFileSync(record, readFileSync(hard, "utf8").replace(/\n/g, "\r\n"));
  expect((await reflection([record], env)).code).toBe(0);
});
