import { test, expect } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findings } from "./check-promote-safety";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const gate = join(import.meta.dir, "check-promote-safety.ts"),
  fix = join(import.meta.dir, "fixtures");
function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, gate, ...args], {
    env: {
      ...process.env,
      BEHIND: "",
      AGE_SECONDS: "",
      MAX_BEHIND: "",
      MAX_AGE_SECONDS: "",
      SCHEMA: join(fix, "schema.yaml"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
const cases: [string, number, Record<string, string>][] = [
  ["safe/environment-gated-push.yml", 0, {}],
  ["safe/digest-pinned-image-input.yml", 0, {}],
  ["safe/first-job-fetches-verified.yml", 0, {}],
  ["safe/first-job-revision-suffix.yml", 0, {}],
  ["safe/gitlab-sha-from-dotenv.yml", 0, {}],
  ["safe/non-prod-fetch-branch.yml", 0, {}],
  ["safe/promotion-sha-from-needs-output.yml", 0, {}],
  ["safe/rendered-state-ref-written.yml", 0, {}],
  ["safe/gitlab-flow-manual-prod.yml", 0, {}],
  ["safe/quoted-keys-environment-prod.yml", 0, {}],
  ["safe/gitlab-block-scalar-indent-first-prod.yml", 0, {}],
  ["safe/gitlab-flow-escaped-strings-when-manual.yml", 0, {}],
  ["safe/gitlab-flow-quoted-when-manual.yml", 0, {}],
  ["safe/gitlab-manual-prod.yml", 0, {}],
  ["safe/manual-verified-deploy.yml", 0, {}],
  ["safe/multijob-env-on-deploy.yml", 0, {}],
  ["safe/multijob-verified-in-deploy.yml", 0, {}],
  ["safe/non-prod-deploy.yml", 0, {}],
  ["safe/push-dispatch-env-verified.yml", 0, {}],
  ["unsafe/auto-push-prod.yml", 1, {}],
  ["unsafe/block-seq-push-prod.yml", 1, {}],
  ["unsafe/deploy-checks-out-pushed-ref.yml", 1, {}],
  ["unsafe/deploy-ref-branch-name.yml", 1, {}],
  ["unsafe/deploy-ref-dispatch-branch-input.yml", 1, {}],
  ["unsafe/deploy-ref-flag-main.yml", 1, {}],
  ["unsafe/downstream-reresolves-verified.yml", 1, {}],
  ["unsafe/gitlab-git-checkout-branch.yml", 1, {}],
  ["unsafe/run-git-fetch-branch.yml", 1, {}],
  ["unsafe/echo-when-manual-prod.yml", 1, {}],
  ["unsafe/quoted-job-key-prod.yml", 1, {}],
  ["unsafe/quoted-on-push-prod.yml", 1, {}],
  ["unsafe/flow-style-push-prod.yml", 1, {}],
  ["unsafe/gitlab-block-scalar-indent-first-when-manual.yml", 1, {}],
  ["unsafe/gitlab-flow-escaped-quote-when-manual.yml", 1, {}],
  ["unsafe/gitlab-flow-nested-when-manual.yml", 1, {}],
  ["unsafe/gitlab-flow-single-quote-escape-when-manual.yml", 1, {}],
  ["unsafe/gitlab-flow-unterminated-when-manual.yml", 1, {}],
  ["unsafe/gitlab-flow-when-in-quoted-string.yml", 1, {}],
  ["unsafe/gitlab-push-rule-prod.yml", 1, {}],
  ["unsafe/gitlab-quoted-only-pushes-prod.yml", 1, {}],
  ["unsafe/latest-artifact-prod.yml", 1, {}],
  ["unsafe/multijob-env-on-other-job.yml", 1, {}],
  ["unsafe/multijob-verified-in-build.yml", 1, {}],
  ["unsafe/mutable-ref-prod.yml", 1, {}],
  ["unsafe/mutable-ref-verified-mention.yml", 1, {}],
  ["unsafe/mutable-ref-with-verified-download.yml", 1, {}],
  ["unsafe/push-and-dispatch-prod.yml", 1, {}],
  ["unsafe/quoted-push-prod.yml", 1, {}],
  ["unsafe/quoted-ref-key-prod.yml", 1, {}],
  ["unsafe/step-input-environment-prod.yml", 1, {}],
];
for (const [file, code, env] of cases)
  test(file, () => expectSpawnExit(run([join(fix, file)], env), code));
test("missing input file fails closed", () =>
  expectSpawnExit(run([join(fix, "absent-file")]), 2));
test("missing directory passes", () =>
  expectSpawnExit(run([], { WORKFLOWS_DIR: join(fix, "none") }), 0));
test("a workflows path that is a regular file fails closed", () => {
  const temp = mkdtempSync(join(tmpdir(), "promote-safety-"));
  try {
    const file = join(temp, "workflows");
    writeFileSync(file, "not a directory\n");
    expectSpawnExit(run([], { WORKFLOWS_DIR: file }), 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an inaccessible workflows path fails closed",
  () => {
    const temp = mkdtempSync(join(tmpdir(), "promote-safety-"));
    try {
      chmodSync(temp, 0);
      expectSpawnExit(run([], { WORKFLOWS_DIR: join(temp, "workflows") }), 2);
    } finally {
      chmodSync(temp, 0o700);
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
for (const dir of ["safe", "unsafe"])
  test(`directory ${dir}`, () =>
    expectSpawnExit(
      run([], { WORKFLOWS_DIR: join(fix, dir) }),
      dir === "safe" ? 0 : 1,
    ));
test("findings explain the missing gate and mutable ref", () => {
  expect(
    run([join(fix, "unsafe/auto-push-prod.yml")]).stdout.toString(),
  ).toContain("environment: protection");
  expect(
    run([join(fix, "unsafe/mutable-ref-prod.yml")]).stdout.toString(),
  ).toContain("mutable ref");
});
const gitlabJob = (body: string) =>
  `deploy-production:\n  stage: deploy\n${body}`;
test("a block scalar header is recognized with either indicator order", () => {
  for (const header of ["|2-", "|2+", ">2-", "|-2", "|+2", "|2", "|-", ">"])
    expect(
      findings(
        gitlabJob(
          `  script: ${header}\n    ./deploy --target production\n    when: manual\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == "push"'\n`,
        ),
      ),
    ).toEqual([{ job: "deploy-production", mode: "a" }]);
});
test("quoted keys are recognized for ref and only", () => {
  for (const line of [`  "ref": main`, `  'ref': main`, `  - { "ref": main }`])
    expect(
      findings(gitlabJob(`  script: ./deploy --target production\n${line}\n`)),
    ).toEqual([{ job: "deploy-production", mode: "b" }]);
  for (const line of [`  "only": [pushes]`, `  'only':\n    - "pushes"`])
    expect(
      findings(gitlabJob(`  script: ./deploy --target production\n${line}\n`)),
    ).toEqual([{ job: "deploy-production", mode: "a" }]);
});
test("a selection by name is reported as (c) with the name it selects", () => {
  const read = (file: string) =>
    findings(readFileSync(join(fix, file), "utf8"));
  expect(read("unsafe/deploy-ref-branch-name.yml")).toEqual([
    { job: "deploy", mode: "c", name: "release" },
  ]);
  expect(read("unsafe/deploy-ref-dispatch-branch-input.yml")).toEqual([
    { job: "deploy", mode: "c", name: "@inputs.branch" },
  ]);
  expect(read("unsafe/run-git-fetch-branch.yml")).toEqual([
    { job: "deploy", mode: "c", name: "release-candidate" },
  ]);
  expect(read("unsafe/downstream-reresolves-verified.yml")).toEqual([
    { job: "deploy", mode: "c", name: "verified" },
  ]);
  expect(read("unsafe/gitlab-git-checkout-branch.yml")).toEqual([
    { job: "deploy-production", mode: "c", name: "release" },
  ]);
  expect(
    run([join(fix, "unsafe/deploy-ref-branch-name.yml")]).stdout.toString(),
  ).toContain("needs.<job>.outputs.<sha>");
});
test("a mutable ref (b) already reports is not reported again as (c)", () => {
  expect(
    findings(readFileSync(join(fix, "unsafe/mutable-ref-prod.yml"), "utf8")),
  ).toEqual([{ job: "promote", mode: "b" }]);
});
// A GitHub Actions expression, `${{ <e> }}`.
const gha = (e: string) => ["$", "{{ ", e, " }}"].join("");
const githubJob = (needs: string, step: string) =>
  `on: { workflow_dispatch: {} }\njobs:\n  deploy:\n${needs}    environment: production\n    steps:\n      - name: Deploy to production\n        run: ${step}\n`;
test("what (c) reads as a name, and what it does not", () => {
  const named = [
    "git pull",
    "git checkout -b hotfix origin/release",
    "git switch release",
    "git reset --hard origin/release",
    "git merge --ff-only origin/release",
    "git rebase origin/release",
    "SHA=$(git rev-parse origin/release)",
    "git -C repo fetch --depth 1 origin refs/heads/release",
    `git fetch origin ${gha("github.head_ref")}`,
    `git fetch origin ${gha("github.event.workflow_run.head_branch")}`,
    "./deploy --target production --ref=release",
    "git rev-parse --verify release^{commit}",
    "git merge 'release'",
    "git checkout -m release",
    "git switch -m release",
    "git fetch -- origin release",
    "git checkout -B hotfix origin/release",
    "git checkout FETCH_HEAD",
    "git fetch origin && git checkout FETCH_HEAD",
    "git fetch origin HEAD && git checkout FETCH_HEAD",
    "git pull origin HEAD",
    'SHA=$(printf "%s" "$(git rev-parse origin/release)")',
    "SHA=$(command git rev-parse origin/release)",
    "/usr/bin/git checkout release",
    "git --no-pager checkout release",
    'git -c "http.extraheader=X Y" fetch origin release',
    "git --git-dir .git checkout release",
  ];
  for (const step of named)
    expect(findings(githubJob("", step)).map((f) => f.mode)).toEqual(["c"]);
  const fixed = [
    `git fetch origin ${gha("needs.gate.outputs.sha")}`,
    'git checkout "$GATED_SHA"',
    "git checkout 0123456789abcdef0123456789abcdef01234567",
    "git rev-parse HEAD",
    "git fetch origin",
    `git fetch origin ${gha("needs.gate.outputs.sha")} && git checkout FETCH_HEAD`,
    "git checkout $(cat gated-sha)",
    "git checkout $(git rev-parse HEAD)",
    "git fetch origin '+refs/heads/*:refs/remotes/origin/*'",
    `git checkout ${gha("inputs.sha")}`,
    "git checkout verified -- deploy/",
    'git merge --ff-only -m "promote release candidate" "$SHA"',
    "git fetch origin \\",
  ];
  for (const step of fixed) expect(findings(githubJob("", step))).toEqual([]);
});
test("the verified pointer by name is (c) only in a job that needs another", () => {
  const step = "git fetch origin verified && ./deploy --target production";
  expect(findings(githubJob("", step))).toEqual([]);
  expect(findings(githubJob("    needs: [gate]\n", step))).toEqual([
    { job: "deploy", mode: "c", name: "verified" },
  ]);
});
test("ref names keep their case", () => {
  expect(
    findings(githubJob("", "git fetch origin refs/heads/Verified")),
  ).toEqual([{ job: "deploy", mode: "c", name: "Verified" }]);
  expect(
    findings(
      githubJob(
        "",
        "git checkout Release && ./deploy --target production && git push origin HEAD:release",
      ),
    ),
  ).toEqual([{ job: "deploy", mode: "c", name: "Release" }]);
});
test("an empty needs list is not an upstream job", () => {
  const step = "git fetch origin verified && ./deploy --target production";
  for (const needs of ["    needs: []\n", "    needs: [ ]\n"])
    expect(findings(githubJob(needs, step))).toEqual([]);
  expect(findings(githubJob("    needs:\n      - gate\n", step))).toEqual([
    { job: "deploy", mode: "c", name: "verified" },
  ]);
});
test("a first job resolves the verified pointer on the remote only once", () => {
  for (const step of [
    "git fetch origin verified && ./gates && git fetch origin verified && git checkout FETCH_HEAD && ./deploy --target production",
    "git fetch origin verified && ./gates && git pull origin verified && ./deploy --target production",
  ])
    expect(findings(githubJob("", step))).toEqual([
      { job: "deploy", mode: "c", name: "verified" },
    ]);
  expect(
    findings(
      githubJob(
        "",
        "git fetch origin verified && git checkout FETCH_HEAD && git rev-parse verified && ./deploy --target production",
      ),
    ),
  ).toEqual([]);
});
test("only a fetch of a ref the job pushes to is exempt", () => {
  const job = (step: string) => findings(githubJob("", step));
  expect(
    job(
      "git fetch origin release-state && ./deploy --target production && git push origin HEAD:release-state",
    ),
  ).toEqual([]);
  for (const step of [
    "git checkout release && ./deploy --target production && git push origin HEAD:release",
    "git fetch origin release && git checkout FETCH_HEAD && ./deploy --target production && git push origin HEAD:release",
    'git fetch origin release && ./deploy --target production && echo "git push origin HEAD:release"',
    `git fetch origin release && ./deploy --target production && echo 'git push origin HEAD:release'`,
    "git fetch origin release && ./deploy --target production && git push fork HEAD:release",
    "git -C source fetch origin release && ./deploy --target production && git -C other push origin HEAD:release",
    "git fetch origin release && ./deploy --target production && git push --dry-run origin HEAD:release",
    "git fetch origin release && ./deploy --target production && git push -n origin HEAD:release",
    "git fetch origin release && ./deploy --target production && git push --delete origin release",
    "git fetch origin release && ./deploy --target production && git push origin :release",
  ])
    expect(job(step).map((f) => f.mode)).toEqual(["c"]);
});
test("a quoted # does not start a comment", () => {
  expect(
    findings(
      githubJob(
        "",
        "echo ' # marker' && git checkout release && ./deploy --target production",
      ),
    ),
  ).toEqual([{ job: "deploy", mode: "c", name: "release" }]);
  expect(
    findings(
      githubJob("", "./deploy --target production # then git checkout release"),
    ),
  ).toEqual([]);
});
test("a pushed ref is exempt only from a real push", () => {
  const job = (step: string) => findings(githubJob("", step));
  for (const step of [
    "git -C state fetch origin release-state && ./deploy --target production && git -C state/ push origin HEAD:release-state",
    "git fetch origin release-state && ./deploy --target production && git -c user.name=bot push origin +HEAD:release-state",
  ])
    expect(job(step)).toEqual([]);
  expect(
    findings(
      githubJob(
        "    needs: gate\n",
        "git fetch origin verified && git fetch origin verified && ./deploy --target production && git push origin HEAD:verified",
      ),
    ),
  ).toEqual([{ job: "deploy", mode: "c", name: "verified" }]);
  expect(
    job(
      "git fetch origin verified && ./deploy --target production && git fetch origin verified && git push origin HEAD:verified",
    ),
  ).toEqual([{ job: "deploy", mode: "c", name: "verified" }]);
});
test("a heredoc body is text, not a push", () => {
  const job = (body: string) =>
    findings(
      `on: { workflow_dispatch: {} }\njobs:\n  deploy:\n    environment: production\n    steps:\n      - name: Deploy to production\n        run: |\n${body
        .split("\n")
        .map((l) => `          ${l}`)
        .join("\n")}\n`,
    );
  expect(
    job(
      "git fetch origin release-state\ncat <<EOF\ngit push origin HEAD:release-state\nEOF\n./deploy --target production",
    ),
  ).toEqual([{ job: "deploy", mode: "c", name: "release-state" }]);
  expect(
    job(
      "git fetch origin release-state\ncat <<'EOF'\nnotes\nEOF\n./deploy --target production\ngit push origin HEAD:release-state",
    ),
  ).toEqual([]);
});
test("a YAML-quoted command is shell text without those quotes", () => {
  const push =
    "git fetch origin release-state && ./deploy --target production && git push origin HEAD:release-state";
  for (const step of [`'${push}'`, `"${push}"`, `'${push} && echo ''done'''`])
    expect(findings(githubJob("", step))).toEqual([]);
  expect(
    findings(
      `deploy-production:\n  when: manual\n  script:\n    - "${push}"\n`,
    ),
  ).toEqual([]);
  expect(
    findings(
      githubJob(
        "",
        `'git fetch origin release-state && ./deploy --target production && echo "git push origin HEAD:release-state"'`,
      ),
    ),
  ).toEqual([{ job: "deploy", mode: "c", name: "release-state" }]);
});
test("a GitLab job in a later stage has an upstream job", () => {
  const pipeline = (stages: string, deploy: string) =>
    `${stages}gate:\n  stage: gate\n  script:\n    - ./gates/check-promotion\n\ndeploy-production:\n${deploy}  when: manual\n  environment: production\n  script:\n    - git fetch origin verified\n    - ./deploy --target production\n`;
  const unsafe: ReturnType<typeof findings> = [
    { job: "deploy-production", mode: "c", name: "verified" },
  ];
  expect(
    findings(pipeline("stages: [gate, deploy]\n\n", "  stage: deploy\n")),
  ).toEqual(unsafe);
  expect(
    findings(
      pipeline("stages:\n  - gate\n  - deploy\n\n", "  stage: deploy\n"),
    ),
  ).toEqual(unsafe);
  expect(findings(pipeline("", "  stage: deploy\n"))).toEqual(unsafe);
  expect(
    findings(
      pipeline("stages: [gate, deploy]\n\n", "  stage: deploy\n  needs: []\n"),
    ),
  ).toEqual([]);
  expect(
    findings(pipeline("stages: [deploy, gate]\n\n", "  stage: deploy\n")),
  ).toEqual([]);
});
test("only a command the shell runs exempts, in a repository its text establishes", () => {
  const job = (step: string) => findings(githubJob("", step));
  const fetchThen = (push: string) =>
    `git fetch origin release-state && ./deploy --target production && ${push}`;
  for (const step of [
    fetchThen("git push origin HEAD:release-state"),
    fetchThen("command git push origin HEAD:release-state"),
    fetchThen("GIT_TRACE=1 git push origin HEAD:release-state"),
    fetchThen("/usr/bin/git push origin HEAD:release-state"),
  ])
    expect(job(step)).toEqual([]);
  for (const step of [
    fetchThen("echo git push origin HEAD:release-state"),
    fetchThen("printf '%s' x git push origin HEAD:release-state"),
    fetchThen("git --git-dir=other/.git push origin HEAD:release-state"),
    fetchThen("git --git-dir other/.git push origin HEAD:release-state"),
    fetchThen("git --work-tree=other push origin HEAD:release-state"),
    fetchThen(
      "git -c remote.origin.url=../fork push origin HEAD:release-state",
    ),
    fetchThen("git -c url.x.insteadOf=y push origin HEAD:release-state"),
    fetchThen("cd other && git push origin HEAD:release-state"),
    fetchThen("GIT_DIR=other/.git git push origin HEAD:release-state"),
    fetchThen(
      "git remote set-url origin ../fork && git push origin HEAD:release-state",
    ),
  ])
    expect(job(step).map((f) => f.mode)).toEqual(["c"]);
  expect(
    findings(
      `on: { workflow_dispatch: {} }\njobs:\n  deploy:\n    environment: production\n    steps:\n      - run: git fetch origin release-state\n      - working-directory: other\n        run: ./deploy --target production && git push origin HEAD:release-state\n`,
    ).map((f) => f.mode),
  ).toEqual(["c"]);
});
test("FETCH_HEAD keeps its origin per repository, set only by a fetch that runs", () => {
  const downstream = (step: string) =>
    findings(githubJob("    needs: gate\n", step));
  expect(
    downstream(`git fetch origin "$SHA" && git checkout FETCH_HEAD`),
  ).toEqual([]);
  expect(
    downstream(
      `git -C state fetch origin "$SHA" && git -C state checkout FETCH_HEAD`,
    ),
  ).toEqual([]);
  for (const step of [
    `echo 'git fetch origin "$SHA"' && git checkout FETCH_HEAD`,
    `echo git fetch origin "$SHA" && git checkout FETCH_HEAD`,
    `git fetch origin "$SHA" && ./deploy --target production --ref "$SHA" && git checkout FETCH_HEAD`,
    `git --git-dir=other/.git fetch origin "$SHA" && git checkout FETCH_HEAD`,
    `git -C other fetch origin "$SHA" && git checkout FETCH_HEAD`,
  ])
    expect(downstream(step)).toEqual([
      { job: "deploy", mode: "c", name: "FETCH_HEAD" },
    ]);
  for (const step of [
    `git fetch origin release-state; git -C other fetch origin "$SHA"; git checkout FETCH_HEAD; ./deploy --target production; git push origin HEAD:release-state`,
    `git fetch origin release-state "$SHA" && git checkout FETCH_HEAD && ./deploy --target production && git push origin HEAD:release-state`,
  ])
    expect(downstream(step)).toEqual([
      { job: "deploy", mode: "c", name: "release-state" },
    ]);
  const heredoc = findings(
    `on: { workflow_dispatch: {} }\njobs:\n  deploy:\n    needs: gate\n    environment: production\n    steps:\n      - name: Deploy to production\n        run: |\n          cat <<'EOF'\n          git fetch origin "$SHA"\n          EOF\n          git checkout FETCH_HEAD\n`,
  );
  expect(heredoc).toEqual([{ job: "deploy", mode: "c", name: "FETCH_HEAD" }]);
});
test("git is recognized however the shell spells it", () => {
  for (const step of [
    `"git" checkout release`,
    `'git' checkout release`,
    `g\\it checkout release`,
    `'g'it checkout release`,
    `x=1; "git" fetch origin release`,
  ])
    expect(findings(githubJob("    needs: gate\n", step))).toEqual([
      { job: "deploy", mode: "c", name: "release" },
    ]);
  expect(findings(githubJob("", "echo digit checkout release"))).toEqual([]);
});
test("an ancestor of a commit is not that commit", () => {
  for (const [needs, step, name] of [
    ["    needs: gate\n", "git checkout HEAD~1", "HEAD~1"],
    ["    needs: gate\n", "git checkout HEAD^", "HEAD^"],
    ["    needs: gate\n", `git checkout "$SHA~2"`, "$SHA~2"],
    ["", "git checkout verified~1", "verified~1"],
    ["", "git rev-parse verified^2", "verified^2"],
  ] as const)
    expect(findings(githubJob(needs, step))).toEqual([
      { job: "deploy", mode: "c", name },
    ]);
  for (const step of [
    `git rev-parse --verify "verified^{commit}"`,
    "git rev-parse HEAD^{commit}",
    `git checkout "$SHA^0"`,
  ])
    expect(findings(githubJob("", step))).toEqual([]);
});
