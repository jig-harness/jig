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
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../lib/test-helpers/expect-spawn-exit.ts";
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
 * call: `pr view 12 --repo <slug> --json labels --jq '.labels[].name'` prints
 * the names one per line (and fails while `view-fails` exists), and
 * `pr edit 12 --repo <slug>` applies its `--add-label` and `--remove-label`
 * values in one change; \`api repos/<slug>/issues/12/events --paginate\` prints
 * the pages in \`events.json\` (none when absent); anything else is refused.
 */
const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
const file = path.join(dir, "labels.json");
const labels = JSON.parse(fs.readFileSync(file, "utf8"));
if (args[0] === "api") {
  if (args[1] !== "repos/example-org/example-repo/issues/12/events" || args[2] !== "--paginate" || args.length !== 3) process.exit(2);
  const events = path.join(dir, "events.json");
  // One array per page, as \`gh api --paginate\` prints them.
  if (fs.existsSync(events)) for (const page of JSON.parse(fs.readFileSync(events, "utf8"))) process.stdout.write(JSON.stringify(page) + "\\n");
  // A later page that fails leaves the earlier ones printed, as \`gh api --paginate\` does.
  if (fs.existsSync(path.join(dir, "events-fail"))) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  process.exit(0);
}
if (args[0] !== "pr" || args[2] !== "12" || args[3] !== "--repo") process.exit(2);
if (args[1] === "view") {
  if (fs.existsSync(path.join(dir, "view-fails"))) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  if (args.slice(5).join(" ") !== "--json labels --jq .labels[].name") process.exit(2);
  process.stdout.write(labels.map((l) => l + "\\n").join(""));
  process.exit(0);
}
if (args[1] !== "edit") process.exit(2);
const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const remove = values("--remove-label");
const add = values("--add-label");
fs.writeFileSync(file, JSON.stringify([...labels.filter((l) => !remove.includes(l)), ...add]));
`;

/** Run the step for a push to PR #12 carrying `labels` when the job runs, as GitHub would. */
function push(
  labels: string[],
  prefix?: string,
  viewFails = false,
  labeledEvents: string[][] = [],
  eventsFail = false,
) {
  const dir = mkdtempSync(join(scratch, "push-"));
  writeFakeProgram(join(dir, "gh"), FAKE_GH);
  writeFileSync(join(dir, "labels.json"), JSON.stringify(labels));
  if (viewFails) writeFileSync(join(dir, "view-fails"), "");
  if (eventsFail) writeFileSync(join(dir, "events-fail"), "");
  const name = `${prefix ?? "jig:"}converged`;
  if (labeledEvents.length > 0)
    writeFileSync(
      join(dir, "events.json"),
      JSON.stringify(
        labeledEvents.map((page) =>
          page.map((created_at) => ({
            event: "labeled",
            label: { name },
            created_at,
          })),
        ),
      ),
    );
  const s = step();
  const result = Bun.spawnSync(["bash", "-e", "-c", s.run], {
    cwd: dir,
    env: {
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      GH_TOKEN: "test-token",
      REPO: "example-org/example-repo",
      PR: "12",
      PUSHED_AT: "2026-01-02T03:04:05Z",
      // The push's event payload, which the step must not trust: it lists converged.
      LABELS: JSON.stringify(["jig:converged"]),
      PREFIX: prefix ?? s.env.PREFIX ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = (() => {
    try {
      return readFileSync(join(dir, "calls.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as string[])
        .filter((c) => c[1] === "edit");
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
  const pushedAt = "2026-01-02T03:04:05Z";
  const before = "2026-01-02T03:00:00Z";
  const after = "2026-01-02T03:10:00Z";

  test("leaves a converged label put on after the push", () => {
    const run = push(["jig:converged"], undefined, false, [[after]]);
    expectSpawnExit(run.result, 0, "the step");
    expect(run.calls).toEqual([]);
    expect(run.after).toEqual(["jig:converged"]);
  });

  test("replaces a converged label put on before the push", () => {
    const run = push(["jig:converged"], undefined, false, [[before]]);
    expectSpawnExit(run.result, 0, "the step");
    expect(run.after).toEqual(["jig:stale"]);
  });

  test("treats a converged label put on in the push's own second as not certifying it", () => {
    const run = push(["jig:converged"], undefined, false, [[pushedAt]]);
    expectSpawnExit(run.result, 0, "the step");
    expect(run.after).toEqual(["jig:stale"]);
  });

  test("chooses the newest event across every page of the history", () => {
    const run = push(["jig:converged"], undefined, false, [[before], [after]]);
    expectSpawnExit(run.result, 0, "the step");
    expect(run.calls).toEqual([]);
    expect(run.after).toEqual(["jig:converged"]);
  });

  test("fails and leaves converged when a page of the history does not read", () => {
    const first = push(["jig:converged"], undefined, false, [[before]], true);
    expectSpawnExitNot(first.result, 0, "the step");
    expect(first.calls).toEqual([]);
    expect(first.after).toEqual(["jig:converged"]);
    // A first page that fails prints nothing: no label history reads as none newer.
    const none = push(["jig:converged"], undefined, false, [], true);
    expectSpawnExitNot(none.result, 0, "the step");
    expect(none.calls).toEqual([]);
    expect(none.after).toEqual(["jig:converged"]);
  });

  test("takes a prefix with a quote or a backslash as data", () => {
    const prefix = 'b"\\o/';
    const run = push([`${prefix}converged`], prefix, false, [[before]]);
    expectSpawnExit(run.result, 0, "the step");
    expect(run.after).toEqual([`${prefix}stale`]);
  });

  test("replaces converged with stale, in one call", () => {
    const { result, calls, after } = push(["area:docs", "jig:converged"]);
    expectSpawnExit(result, 0, "the step");
    expect(after.sort()).toEqual(["area:docs", "jig:stale"]);
    expect(calls).toEqual([
      [
        "pr",
        "edit",
        "12",
        "--repo",
        "example-org/example-repo",
        "--add-label",
        "jig:stale",
        "--remove-label",
        "jig:converged",
      ],
    ]);
  });

  test("reads the labels as they are when it runs, leaving a pull request whose converged is already gone", () => {
    // The event saw converged; by the time the job runs a tick has replaced it.
    const { result, calls, after } = push(["jig:driving"]);
    expectSpawnExit(result, 0, "the step");
    expect(calls).toEqual([]);
    expect(after).toEqual(["jig:driving"]);
  });

  test("fails rather than guess when the labels do not read", () => {
    const { result, calls } = push(["jig:converged"], undefined, true);
    expectSpawnExitNot(result, 0, "the step");
    expect(calls).toEqual([]);
  });

  test("does nothing on a pull request without converged", () => {
    const { result, calls, after } = push(["area:docs", "jig:driving"]);
    expectSpawnExit(result, 0, "the step");
    expect(calls).toEqual([]);
    expect(after).toEqual(["area:docs", "jig:driving"]);
    expect(result.stdout.toString()).toContain("nothing to do");
  });

  test("respects the repository's prefix, a label name beyond ASCII included", () => {
    const { result, after } = push(["bot/converged", "jig:converged"], "bot/");
    expectSpawnExit(result, 0, "the step");
    expect(after.sort()).toEqual(["bot/stale", "jig:converged"]);
    const accented = push(["état·converged"], "état·");
    expectSpawnExit(accented.result, 0, "the step");
    expect(accented.after).toEqual(["état·stale"]);
  });

  test("does nothing when only another prefix's converged is there", () => {
    const { calls, after } = push(["jig:converged"], "bot/");
    expect(calls).toEqual([]);
    expect(after).toEqual(["jig:converged"]);
  });
});
