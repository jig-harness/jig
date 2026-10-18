/**
 * The facts a profile suggestion rests on, gathered from scratch
 * repositories, and the rule that turns them into the lightest profile they
 * support.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  type ComplianceDocument,
  type Contributors,
  countPeople,
  type DeploySignal,
  isAutomationAuthor,
  profileAlternative,
  profileFacts,
  suggestProfile,
} from "../scripts/lib/profile-facts.ts";
import { cleanEnv, runScript, scratchRepo } from "./helpers.ts";

const repos: string[] = [];
afterAll(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const r = scratchRepo(files);
  repos.push(r);
  return r;
};

const DAY_MS = 86_400_000;

/** Commit one change to `dir` as `name <email>`, dated `daysAgo` days back. */
function commitAs(dir: string, name: string, email: string, daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  writeFileSync(join(dir, "log.txt"), `${name} ${email} ${date}\n`, {
    flag: "a",
  });
  const env = cleanEnv({
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  git(dir, ["add", "log.txt"], env);
  git(dir, ["commit", "-q", "-m", `change by ${name}`], env);
}

function git(dir: string, args: string[], env = cleanEnv()) {
  const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A repository with no commits yet. */
function emptyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-audit-history-"));
  repos.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

const people = (
  last_90_days: number,
  shallow = false,
  last_year = last_90_days,
): Contributors => ({
  last_90_days,
  last_year,
  automation_last_year: 0,
  shallow,
});
const deploy: DeploySignal = {
  file: ".github/workflows/deploy.yml",
  matched: ["environment: production"],
};
const threatModel: ComplianceDocument = {
  path: "docs/threat-model.md",
  regimes: ["threat model"],
  via: "path",
};

describe("the suggested profile", () => {
  const none = { deploy_signals: [], compliance_documents: [] };

  test("one person and no deploy signal is solo-lite", () => {
    expect(suggestProfile({ ...none, contributors: people(1) })).toEqual({
      id: "solo-lite",
      why: [
        "one human contributor in the last 90 days, and no CI file names deploy, release or publish work and no tracked file configures a deploy",
      ],
    });
    expect(suggestProfile({ ...none, contributors: people(0) })?.why).toEqual([
      "no human contributor in the last 90 days, and no CI file names deploy, release or publish work and no tracked file configures a deploy",
    ]);
  });

  test("two people in 90 days, or a deploy signal with two in the year, is team-standard", () => {
    expect(suggestProfile({ ...none, contributors: people(2) })).toEqual({
      id: "team-standard",
      why: ["2 human contributors in the last 90 days"],
    });
    expect(
      suggestProfile({
        ...none,
        contributors: people(1, false, 2),
        deploy_signals: [deploy],
      }),
    ).toEqual({
      id: "team-standard",
      why: [
        "CI names deploy, release or publish work: .github/workflows/deploy.yml",
        "2 human contributors in the last year",
      ],
    });
    expect(
      suggestProfile({
        ...none,
        contributors: people(3),
        deploy_signals: [deploy],
      })?.why,
    ).toHaveLength(2);
  });

  test("one person in a year is solo-lite even when CI deploys, with team-standard as the alternative", () => {
    const facts = {
      ...none,
      contributors: people(1),
      deploy_signals: [deploy],
    };
    expect(suggestProfile(facts)).toEqual({
      id: "solo-lite",
      why: [
        "one human contributor in the last year, so no second person reviews",
        "revisit when a second person joins or the deploys need review gates: CI names deploy, release or publish work: .github/workflows/deploy.yml",
      ],
    });
    const dir = repo({
      ".github/workflows/deploy.yml":
        "on: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: ./deploy.sh\n",
    });
    const gathered = profileFacts(dir, [".github/workflows/deploy.yml"]);
    expect(gathered.suggested_profile?.id).toBe("solo-lite");
    expect(gathered.alternative).toEqual({
      id: "team-standard",
      why: [
        "CI names deploy, release or publish work: .github/workflows/deploy.yml",
        "one human contributor in the last year",
      ],
    });
    // Two people in the year but one lately: team-standard, solo-lite beside it.
    commitAs(dir, "Bea", "bea@example.com", 200);
    const lately = profileFacts(dir, [".github/workflows/deploy.yml"]);
    expect(lately.suggested_profile?.id).toBe("team-standard");
    expect(lately.alternative).toEqual({
      id: "solo-lite",
      why: ["one human contributor in the last 90 days"],
    });
    // Facts that point one way have no alternative.
    expect(
      profileFacts(repo({ "README.md": "# x\n" }), ["README.md"]).alternative,
    ).toBeUndefined();
  });

  test("compliance documents ask to consider regulated-strict but never suggest it", () => {
    for (const contributors of [people(1), people(4)]) {
      const suggestion = suggestProfile({
        ...none,
        contributors,
        compliance_documents: [threatModel],
      });
      expect(suggestion?.id).not.toBe("regulated-strict");
      expect(suggestion?.why.at(-1)).toBe(
        "compliance documents found: consider regulated-strict (docs/threat-model.md)",
      );
    }
  });

  test("CI files that could not be read are named, not taken as shipping nothing", () => {
    expect(
      suggestProfile({
        ...none,
        contributors: people(1),
        unreadable_ci_files: [".github/workflows/ship.yml (bad indentation)"],
      })?.why,
    ).toEqual([
      "one human contributor in the last 90 days, and no readable CI file names deploy, release or publish work and no tracked file configures a deploy",
      "unchecked, as they could not be read: .github/workflows/ship.yml",
    ]);
  });

  test("without readable history only a deploy signal settles it", () => {
    expect(suggestProfile({ ...none, contributors: null })).toBeUndefined();
    expect(
      suggestProfile({
        ...none,
        contributors: null,
        compliance_documents: [threatModel],
      }),
    ).toBeUndefined();
    expect(
      suggestProfile({ ...none, contributors: null, deploy_signals: [deploy] })
        ?.id,
    ).toBe("team-standard");
  });

  test("a shallow clone says its count may be low", () => {
    expect(
      suggestProfile({ ...none, contributors: people(1, true) })?.why,
    ).toContain("the clone is shallow, so the contributor count may be low");
  });
});

describe("contributors", () => {
  test("automation is told apart from people", () => {
    for (const [name, email] of [
      ["dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com"],
      ["Renovate Bot", "bot@renovateapp.com"],
      ["renovate", "renovate@example.com"],
      ["GitHub Action", "action@github.com"],
      ["release-bot", "ci-tool[bot]@example.com"],
    ] as const)
      expect(isAutomationAuthor(name, email)).toBe(true);
    for (const [name, email] of [
      ["Ada", "ada@example.com"],
      ["Botond", "botond@example.com"],
      ["Renée", "renee@example.com"],
    ] as const)
      expect(isAutomationAuthor(name, email)).toBe(false);
  });

  test("one person under two addresses, or two names at one address, counts once", () => {
    const at = (name: string, email: string) => ({ time: 0, name, email });
    expect(
      countPeople([
        at("Ada", "ada@work.example"),
        at("ada", "ADA@home.example"),
        at("A. Lovelace", "ada@home.example"),
        at("Bob", "bob@example.com"),
        at("Carol", ""),
      ]),
    ).toBe(3);
    expect(countPeople([])).toBe(0);
  });

  test("are counted from history: people by window, automation apart", () => {
    const dir = emptyRepo();
    // Dates out of order, as after a rebase: the commits on top are older
    // than the ones beneath them, and the recent ones still count.
    commitAs(dir, "Bob", "bob@example.com", 10);
    commitAs(dir, "Alice", "alice@example.com", 1);
    commitAs(dir, "Alice", "ALICE@home.example");
    commitAs(
      dir,
      "dependabot[bot]",
      "1+dependabot[bot]@users.noreply.github.com",
    );
    commitAs(dir, "Carol", "carol@example.com", 200);
    commitAs(dir, "Dave", "dave@example.com", 400);
    const facts = profileFacts(dir, ["log.txt"]);
    expect(facts.contributors).toEqual({
      last_90_days: 2,
      last_year: 3,
      automation_last_year: 1,
      shallow: false,
    });
    expect(facts.suggested_profile?.id).toBe("team-standard");
  });

  test("a repository without commits has no history to count", () => {
    const facts = profileFacts(emptyRepo(), []);
    expect(facts.contributors).toBeNull();
    expect(facts.contributors_unchecked).toBeTruthy();
    expect(facts.suggested_profile).toBeUndefined();
  });
});

describe("deploy and compliance signals", () => {
  const files = {
    ".github/workflows/ci.yml":
      "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
    ".github/workflows/ship.yml": `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Publish the package
        run: |
          bun install
          npm publish --access public
      - uses: actions/deploy-pages@v4
`,
    ".github/workflows/broken.yml": "jobs: [unclosed\n",
    ".github/workflows/release.yml":
      "on: push\njobs:\n  call:\n    uses: ./.github/workflows/publish-package.yml\n",
    ".gitlab-ci.yml": `stages: [test, ship]
.template:
  script: [echo release]
deploy_prod:
  stage: ship
  environment: { name: prod }
  script: ["./ship.sh"]
.upload:
  script: [./scripts/publish.sh]
upload_docs:
  extends: [.upload]
`,
    "docs/threat-model.md": "Notes\n",
    "docs/policies/data.md": "# GDPR record of processing activities\n",
    "docs/plain.md": "# Getting started\n",
    "test/fixtures/hipaa.md": "# HIPAA\n",
    "src/pci.ts": "",
  };

  test("CI files that ship, and documents that name a regime, by path or heading", () => {
    const dir = repo(files);
    const facts = profileFacts(dir, Object.keys(files));
    expect(facts.deploy_signals).toEqual([
      {
        file: ".github/workflows/ship.yml",
        matched: [
          "environment: production",
          'step "Publish the package"',
          "run: npm publish --access public",
          "uses actions/deploy-pages@v4",
        ],
      },
      {
        file: ".github/workflows/release.yml",
        matched: ["uses ./.github/workflows/publish-package.yml"],
      },
      {
        file: ".gitlab-ci.yml",
        matched: [
          "environment: prod",
          "job deploy_prod",
          "script: ./scripts/publish.sh",
        ],
      },
    ]);
    expect(facts.unreadable_ci_files).toHaveLength(1);
    expect(facts.unreadable_ci_files[0]).toStartWith(
      ".github/workflows/broken.yml (",
    );
    expect(facts.compliance_documents).toEqual([
      { path: "docs/threat-model.md", regimes: ["threat model"], via: "path" },
      {
        path: "docs/policies/data.md",
        regimes: ["privacy or data-processing register", "GDPR"],
        via: "heading",
      },
    ]);
    expect(facts.suggested_profile).toEqual({
      id: "solo-lite",
      why: [
        "one human contributor in the last year, so no second person reviews",
        "revisit when a second person joins or the deploys need review gates: CI names deploy, release or publish work: .github/workflows/ship.yml, .github/workflows/release.yml, .gitlab-ci.yml",
        "compliance documents found: consider regulated-strict (docs/threat-model.md, docs/policies/data.md)",
      ],
    });
    expect(facts.alternative?.id).toBe("team-standard");
  });

  test("GitLab templates reached by many paths are read once, and a cycle stops", () => {
    // Each layer's two templates extend both of the layer below: 2^40 paths
    // reach the bottom, which only a once-per-job read finishes.
    const layers = Array.from({ length: 40 }, (_, i) =>
      i === 0
        ? ".l0a:\n  script: [./scripts/publish.sh]\n.l0b:\n  stage: release\n"
        : `.l${i}a:\n  extends: [.l${i - 1}a, .l${i - 1}b]\n.l${i}b:\n  extends: [.l${i - 1}b, .l${i - 1}a]\n`,
    ).join("");
    const pipeline = `${layers}.loop:
  extends: .back
  environment: staging
.back:
  extends: .loop
publish_docs:
  extends: [.l39a, .l39b, .loop]
`;
    const dir = repo({ ".gitlab-ci.yml": pipeline });
    expect(profileFacts(dir, [".gitlab-ci.yml"]).deploy_signals).toEqual([
      {
        file: ".gitlab-ci.yml",
        matched: [
          "job publish_docs",
          "script: ./scripts/publish.sh",
          "stage release",
          "environment: staging",
        ],
      },
    ]);
  });

  test("config-fit reports them offline, in its JSON and under Facts", () => {
    const dir = repo(files);
    const json = runScript("config-fit.ts", ["--offline", "--json"], dir);
    const report = JSON.parse(json.out) as {
      facts: Record<string, string>;
      profile_facts: {
        suggested_profile: { id: string; why: string[] };
        alternative?: { id: string; why: string[] };
      };
    };
    expect(report.profile_facts.suggested_profile.id).toBe("solo-lite");
    expect(report.profile_facts.alternative).toEqual({
      id: "team-standard",
      why: [
        "CI names deploy, release or publish work: .github/workflows/release.yml, .github/workflows/ship.yml, .gitlab-ci.yml",
        "one human contributor in the last year",
      ],
    });
    expect(report.facts.contributors_last_90_days).toBe("1");
    expect(report.facts.deploy_signals).toContain(
      ".github/workflows/ship.yml (environment: production; ",
    );
    expect(report.facts.deploy_signals_unchecked).toStartWith(
      ".github/workflows/broken.yml",
    );
    expect(report.facts.compliance_documents).toBe(
      "docs/policies/data.md (privacy or data-processing register, GDPR), docs/threat-model.md (threat model)",
    );
    const text = runScript("config-fit.ts", ["--offline"], dir).out;
    const facts = text.slice(text.indexOf("## Facts"));
    expect(facts).toContain(
      "- suggested_profile: solo-lite: one human contributor in the last year, so no second person reviews; revisit when a second person joins or the deploys need review gates: CI names deploy, release or publish work: .github/workflows/release.yml, .github/workflows/ship.yml, .gitlab-ci.yml; compliance documents found: consider regulated-strict",
    );
    expect(facts).toContain(
      "- alternative_profile: team-standard: CI names deploy, release or publish work: ",
    );
  });

  test("a one-person repository without CI is solo-lite, offline too", () => {
    const dir = repo({ "README.md": "# Example\n" });
    const report = JSON.parse(
      runScript("config-fit.ts", ["--offline", "--json"], dir).out,
    ) as { facts: Record<string, string> };
    expect(report.facts.deploy_signals).toBe("none");
    expect(report.facts.compliance_documents).toBe("none");
    expect(report.facts.suggested_profile).toStartWith("solo-lite: ");
  });
});

describe("the alternative profile", () => {
  const none = { deploy_signals: [], compliance_documents: [] };

  test("compliance documents beside team-standard make regulated-strict the alternative", () => {
    const facts = {
      ...none,
      contributors: people(3),
      compliance_documents: [
        threatModel,
        { path: "docs/gdpr-gaps.md", regimes: ["GDPR"], via: "path" as const },
      ],
    };
    expect(profileAlternative(facts)).toEqual({
      id: "regulated-strict",
      why: [
        "compliance documents found: docs/threat-model.md, docs/gdpr-gaps.md",
        "the facts never suggest regulated-strict: whether the documents bind the repository is the team's to decide",
      ],
    });
    // Beside solo-lite the documents are a reason in the suggestion, not the alternative.
    expect(
      profileAlternative({
        ...none,
        contributors: people(1),
        compliance_documents: [threatModel],
      }),
    ).toBeUndefined();
    // A declared team-standard counts as team-standard, even without a suggestion.
    expect(
      profileAlternative(
        { ...none, contributors: null, compliance_documents: [threatModel] },
        "team-standard",
      )?.id,
    ).toBe("regulated-strict");
  });

  test("a declared profile the facts do not suggest makes the suggested one the alternative", () => {
    expect(
      profileAlternative({ ...none, contributors: people(1) }, "team-standard"),
    ).toEqual({
      id: "solo-lite",
      why: [
        "the facts suggest solo-lite rather than the declared team-standard",
        "one human contributor in the last 90 days, and no CI file names deploy, release or publish work and no tracked file configures a deploy",
      ],
    });
    // Declared as suggested: the facts' own alternative stands.
    expect(
      profileAlternative({ ...none, contributors: people(1) }, "solo-lite"),
    ).toBeUndefined();
  });

  test("config-fit reads the declared profile from the audit record", () => {
    const dir = repo({
      "README.md": "# Example\n",
      "audit.yaml": `version: 1
plugin_version: 0.51.0
date: 2026-01-02
commit: abc
profile: team-standard
criteria: {}
`,
    });
    const run = runScript(
      "config-fit.ts",
      ["--offline", "--json", "--record", "audit.yaml"],
      dir,
    );
    const report = JSON.parse(run.out) as {
      profile_facts: { alternative?: { id: string } };
    };
    expect(report.profile_facts.alternative?.id).toBe("solo-lite");
  });
});

describe("deploy signals outside CI", () => {
  test("service units, a deploy directory, platform files and tag-triggered workflows", () => {
    const files = {
      "deploy/app.service":
        "[Unit]\nDescription=app\n[Service]\nExecStart=/opt/app/bin/run\n",
      "deploy/update.timer": "[Timer]\nOnCalendar=hourly\n",
      "deploy/install.sh": "#!/bin/sh\n",
      "deploy/README.md": "# Deploying\n",
      "infra/README.md": "# Notes only\n",
      "fly.toml": 'app = "example"\n',
      Procfile: "web: bin/server\nrelease: bin/migrate\n",
      "test/fixtures/x.service": "[Service]\n",
      ".github/workflows/tagged.yml":
        "on:\n  push:\n    tags: ['v*']\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make dist\n",
    };
    const dir = repo(files);
    const signals = profileFacts(dir, Object.keys(files)).deploy_signals;
    expect(signals).toEqual([
      { file: ".github/workflows/tagged.yml", matched: ["on: push tags v*"] },
      {
        file: "deploy/app.service",
        matched: ["systemd service unit", "ExecStart=/opt/app/bin/run"],
      },
      { file: "deploy/update.timer", matched: ["systemd timer unit"] },
      { file: "deploy/", matched: ["deploy files: deploy/install.sh"] },
      { file: "fly.toml", matched: ["Fly.io app configuration"] },
      { file: "Procfile", matched: ["process types: web, release"] },
    ]);
    expect(
      suggestProfile({
        contributors: people(1),
        deploy_signals: signals,
        compliance_documents: [],
      })?.why[1],
    ).toBe(
      "revisit when a second person joins or the deploys need review gates: CI names deploy, release or publish work: .github/workflows/tagged.yml, and tracked files configure a deploy: deploy/app.service, deploy/update.timer, deploy/, fly.toml, Procfile",
    );
  });

  test("a deploy directory or unit that is only test data, templates or vendored copies is no signal", () => {
    const files = {
      "infra/tests/fixtures/example.tf": "resource {}\n",
      "deploy/templates/example.sh": "#!/bin/sh\n",
      "infrastructure/vendor/mod/main.tf": "resource {}\n",
      "infra/testdata/example.tf": "resource {}\n",
      "deploy/__fixtures__/example.sh": "#!/bin/sh\n",
      "testdata/example.service": "[Service]\nExecStart=/bin/true\n",
    };
    const dir = repo(files);
    expect(profileFacts(dir, Object.keys(files)).deploy_signals).toEqual([]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a unit, Procfile or platform configuration that cannot be read is named as unchecked, not fatal",
    () => {
      const files = {
        "deploy/app.service": "[Service]\nExecStart=/opt/app/bin/run\n",
        "deploy/update.timer": "[Timer]\nOnCalendar=hourly\n",
        "fly.toml": 'app = "example"\n',
        Procfile: "web: bin/server\n",
      };
      const dir = repo(files);
      for (const f of Object.keys(files)) chmodSync(join(dir, f), 0o000);
      const facts = profileFacts(dir, Object.keys(files));
      // Named by its file, as a reader can judge without its text.
      expect(facts.deploy_signals).toEqual([
        { file: "deploy/app.service", matched: ["systemd service unit"] },
        { file: "deploy/update.timer", matched: ["systemd timer unit"] },
        { file: "fly.toml", matched: ["Fly.io app configuration"] },
      ]);
      expect(facts.unreadable_ci_files.map((u) => u.split(" (")[0])).toEqual([
        "deploy/app.service",
        "deploy/update.timer",
        "fly.toml",
        "Procfile",
      ]);
    },
  );
});
