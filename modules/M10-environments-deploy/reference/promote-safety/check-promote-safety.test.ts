import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findings } from "./check-promote-safety";
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
  ["unsafe/deploy-ref-flag-main.yml", 1, {}],
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
  test(file, () => expect(run([join(fix, file)], env).exitCode).toBe(code));
test("missing input file fails closed", () =>
  expect(run([join(fix, "absent-file")]).exitCode).toBe(2));
test("missing directory passes", () =>
  expect(run([], { WORKFLOWS_DIR: join(fix, "none") }).exitCode).toBe(0));
test("a workflows path that is a regular file fails closed", () => {
  const temp = mkdtempSync(join(tmpdir(), "promote-safety-"));
  try {
    const file = join(temp, "workflows");
    writeFileSync(file, "not a directory\n");
    expect(run([], { WORKFLOWS_DIR: file }).exitCode).toBe(2);
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
      expect(run([], { WORKFLOWS_DIR: join(temp, "workflows") }).exitCode).toBe(
        2,
      );
    } finally {
      chmodSync(temp, 0o700);
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
for (const dir of ["safe", "unsafe"])
  test(`directory ${dir}`, () =>
    expect(run([], { WORKFLOWS_DIR: join(fix, dir) }).exitCode).toBe(
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
