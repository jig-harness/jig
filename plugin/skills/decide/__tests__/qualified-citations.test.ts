/**
 * Citations that name another repository (`beta:ADR-0002`,
 * `beta:src/auth.ts`): the sheet kit's grammar, the freshness guard's
 * resolution against a configured clone at its recorded commit, the
 * configuration, and both sheet genres' validators.
 *
 * Two fixture repositories number their ADRs from `ADR-0001`, as two
 * repositories commonly do, so a citation resolved against the wrong one
 * reads a different file.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitIdentityEnv } from "../../drive-pr/scripts/lib/proc.ts";
import { parseSource as parseExplainer } from "../../explain/scripts/explainer-sheet/source.ts";
import { parseSource as parseDecision } from "../scripts/decision-sheet/source.ts";
import { sheetRepositories } from "../scripts/lib/overlay.ts";
import {
  checkFreshness,
  citedPaths,
  citedRepositories,
  type OtherRepositories,
  repositoryProblems,
} from "../scripts/sheet-kit/freshness.ts";

const gitEnv = gitIdentityEnv();
/** The environment of a CLI run that reads the fixture repository's own configuration, not the suite's overlay. */
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...gitEnv, JIG_USER_LAYER: "off" };
  delete env.JIG_OVERLAY;
  return env;
}
/** Asserts a CLI run's exit code, printing its output when it differs. */
const expectExit = (
  r: ReturnType<typeof spawnSync>,
  code: number,
  label?: string,
) =>
  expectSpawnExit(
    { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
    code,
    label,
  );
const DECISION_CLI = resolve(
  import.meta.dir,
  "../scripts/decision-sheet/decision-sheet.ts",
);
const EXPLAINER_CLI = resolve(
  import.meta.dir,
  "../../explain/scripts/explainer-sheet/explainer-sheet.ts",
);

/** A throwaway git repository holding `files` in one commit. */
function repoWith(files: Record<string, string>): {
  dir: string;
  commit: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "qualified-citations-"));
  const git = (...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        ...args,
      ],
      { cwd: dir, encoding: "utf8", env: gitEnv },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "facts");
  return { dir, commit: git("rev-parse", "HEAD") };
}

/** The consumer repository (alpha) and another repository (beta), each with its own `ADR-0002`. */
function twoRepositories(extra: Record<string, string> = {}) {
  const alpha = repoWith({
    "docs/adr/ADR-0002-alpha-decision.md": "alpha decision",
    "src/a.ts": "one",
    ...extra,
  });
  const beta = repoWith({
    "docs/adr/ADR-0002-beta-decision.md": "beta decision",
    "apps/api/auth.ts": "auth",
  });
  const others: OtherRepositories = {
    verified: { beta: beta.commit },
    clones: {
      beta: { root: beta.dir, adrDirectory: "docs/adr" },
    },
  };
  return { alpha, beta, others };
}

describe("the citation grammar", () => {
  it("lists a qualified path and a qualified ADR beside unqualified ones", () => {
    expect(
      citedPaths([
        "src/a.ts#f; beta:apps/api/auth.ts:12-40 (the check); ADR-0002",
        "beta:ADR-0002",
      ]),
    ).toEqual(["beta:apps/api/auth.ts", "src/a.ts"]);
    expect(citedRepositories(["beta:ADR-0002; gamma:docs/x.md"])).toEqual([
      "beta",
      "gamma",
    ]);
  });

  it("leaves a line suffix, a URL, an issue key and prose alone", () => {
    const text = [
      "src/a.ts:12-40",
      "see https://example.com/page.html",
      "ENG-123",
      "note: src/a.ts",
      "Makefile:12",
    ];
    expect(citedRepositories(text)).toEqual([]);
    expect(citedPaths(text)).toEqual(["src/a.ts"]);
  });

  it("reads a qualified path that starts with a digit or a hyphen", () => {
    expect(citedPaths(["beta:2026/auth.ts", "beta:-tools/auth.ts"])).toEqual([
      "beta:-tools/auth.ts",
      "beta:2026/auth.ts",
    ]);
    expect(citedRepositories(["beta:2026/auth.ts"])).toEqual(["beta"]);
  });

  it("reads a qualified dotfile and a qualified single-segment directory", () => {
    expect(citedPaths(["beta:.gitignore", "beta:services/"])).toEqual([
      "beta:.gitignore",
      "beta:services/",
    ]);
  });

  it("reads a qualified path inside backticks, spaces included", () => {
    expect(citedPaths(["`beta:.run/Backend Dev.run.xml`"])).toEqual([
      "beta:.run/Backend Dev.run.xml",
    ]);
    expect(citedPaths(["`beta:apps/api/auth.ts`"])).toEqual([
      "beta:apps/api/auth.ts",
    ]);
  });

  it("splits the qualifier off a quoted path before its line suffix", () => {
    const quoted = ["`beta:2026/Auth Flow.ts`", "`beta:2026/Auth Flow.ts:12`"];
    expect(citedPaths(quoted)).toEqual(["beta:2026/Auth Flow.ts"]);
    expect(citedRepositories(quoted)).toEqual(["beta"]);
  });

  it("does not read a qualified token as an unqualified one", () => {
    // A bare scan would find `ADR-0002` and `docs/adr/ADR-0002-x.md`'s ADR in the consumer repository.
    const { alpha, others } = twoRepositories();
    const result = checkFreshness(
      ["beta:docs/adr/ADR-0002-beta-decision.md", "beta:ADR-0002"],
      alpha.commit,
      alpha.dir,
      "docs/adr",
      others,
    );
    expect(result.checked).toEqual(["beta:docs/adr/ADR-0002-beta-decision.md"]);
    expect(result.unresolved).toEqual([]);
  });
});

describe("checking a qualified citation", () => {
  it("resolves a bare ADR in the consumer repository and a qualified one in the other", () => {
    const { alpha, beta, others } = twoRepositories();
    writeFileSync(
      join(beta.dir, "docs/adr/ADR-0002-beta-decision.md"),
      "beta decision, amended",
    );
    // The consumer's own ADR-0002 is cited too: only the other repository's changed.
    const result = checkFreshness(
      ["ADR-0002", "beta:ADR-0002"],
      alpha.commit,
      alpha.dir,
      "docs/adr",
      others,
    );
    expect(result).toEqual({
      commit: alpha.commit,
      checked: [
        "beta:docs/adr/ADR-0002-beta-decision.md",
        "docs/adr/ADR-0002-alpha-decision.md",
      ].sort(),
      unresolved: [],
      changed: ["beta:docs/adr/ADR-0002-beta-decision.md"],
    });
  });

  it("does not report the other repository's ADR as changed when only the consumer's did", () => {
    const { alpha, others } = twoRepositories();
    writeFileSync(
      join(alpha.dir, "docs/adr/ADR-0002-alpha-decision.md"),
      "alpha decision, amended",
    );
    const result = checkFreshness(
      ["ADR-0002", "beta:ADR-0002"],
      alpha.commit,
      alpha.dir,
      "docs/adr",
      others,
    );
    expect(result.changed).toEqual(["docs/adr/ADR-0002-alpha-decision.md"]);
  });

  it("compares a qualified path at the other repository's recorded commit", () => {
    const { alpha, beta, others } = twoRepositories();
    writeFileSync(join(beta.dir, "apps/api/auth.ts"), "auth, amended");
    const result = checkFreshness(
      ["beta:apps/api/auth.ts#check", "src/a.ts"],
      alpha.commit,
      alpha.dir,
      "docs/adr",
      others,
    );
    expect(result.changed).toEqual(["beta:apps/api/auth.ts"]);
    expect(result.checked).toEqual(["beta:apps/api/auth.ts", "src/a.ts"]);
  });

  it("keeps an unqualified path absent from the consumer repository unresolved", () => {
    const { alpha, others } = twoRepositories();
    // `apps/api/auth.ts` exists in beta only.
    const result = checkFreshness(
      ["apps/api/auth.ts", "beta:apps/api/gone.ts"],
      alpha.commit,
      alpha.dir,
      "docs/adr",
      others,
    );
    expect(result.unresolved).toEqual([
      "apps/api/auth.ts",
      "beta:apps/api/gone.ts",
    ]);
  });

  it("uses the other repository's ADR directory", () => {
    const { alpha } = twoRepositories();
    const gamma = repoWith({ "decisions/ADR-0002-gamma.md": "gamma" });
    const result = checkFreshness(
      ["gamma:ADR-0002"],
      alpha.commit,
      alpha.dir,
      "docs/adr",
      {
        verified: { gamma: gamma.commit },
        clones: { gamma: { root: gamma.dir, adrDirectory: "decisions" } },
      },
    );
    expect(result.checked).toEqual(["gamma:decisions/ADR-0002-gamma.md"]);
  });

  it("refuses a qualified citation whose repository has no configured clone", () => {
    const { alpha } = twoRepositories();
    expect(() =>
      checkFreshness(["gamma:ADR-0002"], alpha.commit, alpha.dir, "docs/adr", {
        verified: { gamma: alpha.commit },
        clones: {},
      }),
    ).toThrow(/repository "gamma", which has no clone configured/);
  });

  it("refuses a qualified citation whose repository has no recorded commit", () => {
    const { alpha, others } = twoRepositories();
    expect(() =>
      checkFreshness(["beta:ADR-0002"], alpha.commit, alpha.dir, "docs/adr", {
        ...others,
        verified: {},
      }),
    ).toThrow(/records no commit for it/);
  });

  it("throws on a recorded commit the other clone does not have", () => {
    const { alpha, others } = twoRepositories();
    expect(() =>
      checkFreshness(["beta:ADR-0002"], alpha.commit, alpha.dir, "docs/adr", {
        ...others,
        verified: { beta: alpha.commit },
      }),
    ).toThrow(
      /verifiedAt\.repositories\.beta .* is not in the clone of "beta"/,
    );
  });

  it("refuses a configured location that is not the top of a clone", () => {
    const { alpha, beta } = twoRepositories();
    const inside = join(beta.dir, "apps");
    expect(() =>
      checkFreshness(["beta:ADR-0002"], alpha.commit, alpha.dir, "docs/adr", {
        verified: { beta: beta.commit },
        clones: { beta: { root: inside, adrDirectory: "docs/adr" } },
      }),
    ).toThrow(/not the top of a git clone/);
    expect(() =>
      checkFreshness(["beta:ADR-0002"], alpha.commit, alpha.dir, "docs/adr", {
        verified: { beta: beta.commit },
        clones: {
          beta: { root: join(beta.dir, "missing"), adrDirectory: "docs/adr" },
        },
      }),
    ).toThrow(/does not exist/);
  });
});

describe("a qualifier the grammar does not accept", () => {
  it.each([
    "Beta:ADR-0002",
    "**beta:ADR-0002**",
    "see:beta:ADR-0002",
    "beta:`apps/api/auth.ts`",
    "Beta:apps/api/auth.ts",
    "Beta:.gitignore",
    "Beta:services/",
    "Beta:2026/auth.ts",
    "beta:ENG-123",
    "Beta:ENG-123",
    "1beta:ENG-123",
    "`Beta:2026/Auth Flow.ts`",
  ])("is named, never read as a citation of this repository: %s", (text) => {
    const problems = repositoryProblems([text], { beta: "abc1234" });
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems)
      expect(problem).toContain("is placed like a repository qualifier");
  });

  it("leaves accepted forms, line suffixes and URLs alone", () => {
    expect(
      repositoryProblems(
        [
          "beta:ADR-0002; (beta:apps/api/auth.ts:12-40)",
          "`beta:.run/Backend Dev.run.xml`",
          "src/a.ts:12; https://example.com/a.html; Makefile:12",
          "src/a.ts:check; auth.ts:check; ENG-123",
          "beta:2026/auth.ts; beta:.gitignore; beta:services/",
        ],
        { beta: "abc1234" },
      ),
    ).toEqual([]);
  });

  it("fails a decision source", () => {
    expect(() =>
      parseDecision(
        decisionSource(["Beta:ADR-0002"], "abcdef1", { beta: "1234567" }),
      ),
    ).toThrow(/is placed like a repository qualifier/);
  });
});

describe("repositoryProblems", () => {
  it("names each missing commit and each unconfigured repository", () => {
    expect(
      repositoryProblems(["beta:ADR-0002", "gamma:x.md"], { beta: "abc1234" }, [
        "gamma",
      ]),
    ).toEqual([
      'a citation names repository "beta", which has no clone configured: set sheets.repositories.beta in .config/jig.yaml',
      'a citation names repository "gamma", but verifiedAt.repositories records no commit for it',
    ]);
  });

  it("reports nothing for a sheet with no qualified citation", () => {
    expect(repositoryProblems(["ADR-0002", "src/a.ts"], undefined, [])).toEqual(
      [],
    );
  });
});

describe("sheets.repositories", () => {
  it("maps a name to its clone, resolved from the consumer root, with its ADR directory detected", () => {
    const beta = repoWith({ "docs/decisions/ADR-0002-x.md": "x" });
    expect(
      sheetRepositories(
        {
          sheets: {
            repositories: { beta: beta.dir, local: "../local-clone" },
          },
        },
        "/work/alpha",
      ),
    ).toEqual({
      beta: { root: beta.dir, adrDirectory: "docs/decisions" },
      local: {
        root: resolve("/work/alpha", "../local-clone"),
        adrDirectory: "docs/adr",
      },
    });
  });

  it("is empty when the section is absent", () => {
    expect(sheetRepositories({}, "/work/alpha")).toEqual({});
  });

  it("refuses a bad name and a bad location, naming the field", () => {
    expect(() =>
      sheetRepositories({ sheets: { repositories: { Beta: "x" } } }, "/w"),
    ).toThrow(/sheets\.repositories\.Beta: a repository name is lowercase/);
    expect(() =>
      sheetRepositories({ sheets: { repositories: { beta: 3 } } }, "/w"),
    ).toThrow(/sheets\.repositories\.beta must be a nonempty path/);
    expect(() =>
      sheetRepositories({ sheets: { repositories: ["x"] } }, "/w"),
    ).toThrow(/sheets\.repositories must be a mapping/);
  });
});

/** A decision source citing `sources`, verified at `commit` and, for beta, at `beta`. */
function decisionSource(
  sources: string[],
  commit: string,
  repositories?: Record<string, string>,
) {
  const source = JSON.parse(
    // The pilot fixture: valid and complete.
    readFileSync(
      join(import.meta.dir, "fixtures/decision-sheet/pilot.json"),
      "utf8",
    ),
  );
  source.verifiedAt = {
    date: "2026-10-20",
    commit,
    ...(repositories ? { repositories } : {}),
  };
  source.currentBehaviour = sources.map((s, i) => ({
    text: `Claim ${i}.`,
    source: s,
  }));
  delete source.settled;
  for (const call of source.calls) delete call.facts;
  return source;
}

describe("the decision source", () => {
  const commit = "abcdef1";

  it("accepts a qualified citation whose repository has a recorded commit", () => {
    expect(() =>
      parseDecision(
        decisionSource(["beta:ADR-0002"], commit, { beta: "1234567" }),
      ),
    ).not.toThrow();
  });

  it("rejects one without a recorded commit, and a malformed recorded entry", () => {
    expect(() =>
      parseDecision(decisionSource(["beta:ADR-0002"], commit)),
    ).toThrow(/records no commit for it/);
    expect(() =>
      parseDecision(
        decisionSource(["src/a.ts"], commit, { Beta: "not-a-commit" }),
      ),
    ).toThrow(
      /repository names are lowercase[\s\S]*a lowercase git commit hash/,
    );
  });

  describe("on the command line", () => {
    function consumer(config: string) {
      const beta = repoWith({
        "docs/adr/ADR-0002-beta-decision.md": "beta decision",
      });
      const alpha = repoWith({
        ".config/jig.yaml": config.replace("{beta}", beta.dir),
        "docs/adr/ADR-0002-alpha-decision.md": "alpha decision",
      });
      writeFileSync(
        join(alpha.dir, "decision.json"),
        JSON.stringify(
          decisionSource(["ADR-0002", "beta:ADR-0002"], alpha.commit, {
            beta: beta.commit,
          }),
        ),
      );
      return { alpha, beta };
    }
    const run = (args: string[], cwd: string) =>
      spawnSync(process.execPath, [DECISION_CLI, ...args], {
        cwd,
        encoding: "utf8",
        env: cliEnv(),
      });

    it("validate rejects a qualified citation for a repository with no configured clone", () => {
      const { alpha } = consumer("review:\n  bots: []\n");
      const r = run(["validate", "decision.json"], alpha.dir);
      expectExit(r, 1);
      expect(r.stderr).toContain(
        'repository "beta", which has no clone configured: set sheets.repositories.beta',
      );
    });

    it("validate rejects a clone that is missing, not the top of a git clone, or lacks the recorded commit", () => {
      const missing = consumer(
        "sheets:\n  repositories:\n    beta: {beta}/gone\n",
      );
      const gone = run(["validate", "decision.json"], missing.alpha.dir);
      expectExit(gone, 1);
      expect(gone.stderr).toContain("which does not exist");

      const nested = consumer(
        "sheets:\n  repositories:\n    beta: {beta}/docs\n",
      );
      const sub = run(["validate", "decision.json"], nested.alpha.dir);
      expectExit(sub, 1);
      expect(sub.stderr).toContain("not the top of a git clone");

      const stranger = repoWith({ "x.md": "x" });
      const unknown = consumer(
        `sheets:\n  repositories:\n    beta: ${stranger.dir}\n`,
      );
      const lacking = run(["validate", "decision.json"], unknown.alpha.dir);
      expectExit(lacking, 1);
      expect(lacking.stderr).toContain("is not in the clone of");
    });

    it("validate accepts it once the clone is configured", () => {
      const { alpha } = consumer(
        "sheets:\n  repositories:\n    beta: {beta}\n",
      );
      const r = run(["validate", "decision.json"], alpha.dir);
      expect(r.stderr).toBe("");
      expectExit(r, 0);
    });

    it("render --require-fresh passes, then refuses once the other repository's ADR changed", () => {
      const { alpha, beta } = consumer(
        "sheets:\n  repositories:\n    beta: {beta}\n",
      );
      const render = () =>
        run(
          ["render", "decision.json", "--require-fresh", "--out", "out"],
          alpha.dir,
        );
      expectExit(render(), 0);
      writeFileSync(
        join(beta.dir, "docs/adr/ADR-0002-beta-decision.md"),
        "beta decision, amended",
      );
      const stale = render();
      expectExit(stale, 3);
      expect(stale.stderr).toContain("beta:docs/adr/ADR-0002-beta-decision.md");
    });

    it("render --require-fresh refuses when the clone is not configured", () => {
      const { alpha } = consumer("review:\n  bots: []\n");
      const r = run(
        ["render", "decision.json", "--require-fresh", "--out", "out"],
        alpha.dir,
      );
      expectExit(r, 3);
      expect(r.stderr).toContain("has no clone configured");
    });
  });
});

describe("the explainer source", () => {
  const minimal = (
    sources: string[],
    repositories?: Record<string, string>,
  ) => ({
    schema: "explainer-sheet/v1",
    id: "minimal",
    title: "A minimal explainer",
    verifiedAt: {
      date: "2026-10-20",
      commit: "abcdef1",
      ...(repositories ? { repositories } : {}),
    },
    summary: "One paragraph.",
    scope: { covers: ["One thing"] },
    sections: [
      {
        id: "only",
        title: "Only section",
        claims: sources.map((source, i) => ({ text: `Claim ${i}.`, source })),
      },
    ],
  });

  it("takes the qualified form for a path, an ADR and a quoted path", () => {
    expect(() =>
      parseExplainer(
        minimal(
          [
            "beta:ADR-0002",
            "beta:apps/api/auth.ts#check (the guard)",
            "beta:apps/api/auth.ts:12-40; src/a.ts",
            "`beta:.run/Backend Dev.run.xml`",
          ],
          { beta: "1234567" },
        ),
      ),
    ).not.toThrow();
  });

  it("rejects a qualified citation with no recorded commit", () => {
    expect(() => parseExplainer(minimal(["beta:ADR-0002"]))).toThrow(
      /records no commit for it/,
    );
  });

  it("rejects a qualified issue key", () => {
    expect(() =>
      parseExplainer(minimal(["beta:ENG-123"], { beta: "1234567" })),
    ).toThrow(/qualifies an issue key/);
  });

  it("still rejects prose and a qualifier with nothing after it", () => {
    expect(() =>
      parseExplainer(minimal(["trust me"], { beta: "1234567" })),
    ).toThrow(/is not a repository path/);
    expect(() =>
      parseExplainer(minimal(["beta:"], { beta: "1234567" })),
    ).toThrow(/is not a repository path/);
  });

  it("validate on the command line rejects an unconfigured repository", () => {
    const beta = repoWith({ "docs/adr/ADR-0002-b.md": "b" });
    const alpha = repoWith({ "README.md": "readme" });
    writeFileSync(
      join(alpha.dir, "source.json"),
      JSON.stringify(minimal(["beta:ADR-0002"], { beta: beta.commit })),
    );
    const run = () =>
      spawnSync(process.execPath, [EXPLAINER_CLI, "validate", "source.json"], {
        cwd: alpha.dir,
        encoding: "utf8",
        env: cliEnv(),
      });
    const refused = run();
    expectExit(refused, 1);
    expect(refused.stderr).toContain("has no clone configured");
    mkdirSync(join(alpha.dir, ".config"));
    writeFileSync(
      join(alpha.dir, ".config/jig.yaml"),
      `sheets:\n  repositories:\n    beta: ${beta.dir}\n`,
    );
    expectExit(run(), 0);
  });
});
