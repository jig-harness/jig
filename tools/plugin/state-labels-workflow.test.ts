/**
 * drive-pr's optional state-labels workflow template: on a push to a pull
 * request it replaces `converged` with `stale`, and it leaves a pull request
 * without `converged` as it is. The template leaves Jig for other
 * repositories, so it is held to the lints Jig holds its own workflows to
 * (M13's workflow conventions, M7's PR-target safety, actionlint where it is
 * installed), and its run script is run against a fake `gh`. It lives here
 * rather than in the skill's `__tests__/` because the lints are Jig's,
 * outside `plugin/`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { load } from "../../plugin/shared/vendor/js-yaml.mjs";

const root = resolve(import.meta.dirname, "../..");
const templates = join(root, "plugin/skills/drive-pr/templates/github");
const template = join(templates, "state-labels.yml");

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "jig-state-labels-wf-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function spawn(argv: string[]) {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  return Bun.spawnSync(argv, {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("the template passes Jig's workflow lints", () => {
  test("the workflow-convention lint", () => {
    const empty = join(scratch, "conventions-root");
    mkdirSync(empty, { recursive: true });
    const result = spawn([
      process.execPath,
      join(
        root,
        "modules/M13-pipeline-economy/reference/workflow-conventions/check-workflow-conventions.ts",
      ),
      "--root",
      empty,
      "--workflows",
      templates,
    ]);
    expectSpawnExit(result, 0, "workflow-conventions");
  });

  test("the PR-target safety lint", () => {
    const result = spawn([
      process.execPath,
      join(
        root,
        "modules/M7-pr-lifecycle-review/reference/pr-target-safety/check-pr-target-safety.ts",
      ),
      template,
    ]);
    expectSpawnExit(result, 0, "pr-target");
  });

  const actionlint = Bun.which("actionlint");
  test.skipIf(actionlint === null && !process.env.CI)(
    "actionlint (skipped locally without actionlint; mise.toml pins it)",
    () => {
      expect(actionlint).not.toBeNull();
      expectSpawnExit(
        spawn([actionlint ?? "actionlint", template]),
        0,
        "actionlint",
      );
    },
  );
});

interface Step {
  run: string;
  env: Record<string, string>;
}

/** The template's one run step. */
function step(): Step {
  const wf = load(readFileSync(template, "utf8")) as {
    jobs: { stale: { steps: Step[] } };
  };
  const [only] = wf.jobs.stale.steps;
  if (only === undefined) throw new Error("the template has no step");
  return only;
}

/**
 * A `gh` that keeps PR #12's labels in `labels.json` beside it and logs each
 * call: `POST …/labels` adds the `labels[]` field, `DELETE …/labels/<name>`
 * removes the decoded name.
 */
const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\\n");
const file = path.join(dir, "labels.json");
const labels = JSON.parse(fs.readFileSync(file, "utf8"));
const method = args[args.indexOf("--method") + 1];
const endpoint = args.find((a) => a.startsWith("repos/"));
if (args[0] !== "api" || endpoint === undefined) process.exit(2);
if (method === "POST") {
  const added = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice(9));
  fs.writeFileSync(file, JSON.stringify([...labels, ...added]));
} else if (method === "DELETE") {
  const name = decodeURIComponent(endpoint.split("/labels/")[1]);
  fs.writeFileSync(file, JSON.stringify(labels.filter((l) => l !== name)));
} else process.exit(2);
`;

/** Run the step for a push to PR #12 carrying `labels`, as GitHub would. */
function push(labels: string[], prefix?: string) {
  const dir = mkdtempSync(join(scratch, "push-"));
  writeFakeProgram(join(dir, "gh"), FAKE_GH);
  writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
  const s = step();
  const result = Bun.spawnSync(["bash", "-e", "-c", s.run], {
    cwd: dir,
    env: {
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      GH_TOKEN: "test-token",
      REPO: "example-org/example-repo",
      PR: "12",
      // What `toJSON(github.event.pull_request.labels.*.name)` renders.
      LABELS: JSON.stringify(labels, null, 2),
      PREFIX: prefix ?? s.env.PREFIX ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = (() => {
    try {
      return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  })();
  const after = JSON.parse(
    readFileSync(join(dir, "labels.json"), "utf8"),
  ) as string[];
  return { result, calls, after };
}

describe("on a push to a pull request", () => {
  test("replaces converged with stale", () => {
    const { result, after } = push(["area:docs", "jig:converged"]);
    expectSpawnExit(result, 0, "the step");
    expect(after.sort()).toEqual(["area:docs", "jig:stale"]);
  });

  test("does nothing on a pull request without converged", () => {
    const { result, calls, after } = push(["area:docs", "jig:driving"]);
    expectSpawnExit(result, 0, "the step");
    expect(calls).toEqual([]);
    expect(after).toEqual(["area:docs", "jig:driving"]);
    expect(result.stdout.toString()).toContain("nothing to do");
  });

  test("respects the repository's prefix, escaping it in the label's path", () => {
    const { result, after } = push(["bot/converged", "jig:converged"], "bot/");
    expectSpawnExit(result, 0, "the step");
    expect(after.sort()).toEqual(["bot/stale", "jig:converged"]);
  });
});
