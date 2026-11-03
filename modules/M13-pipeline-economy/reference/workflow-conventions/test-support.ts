// What the workflow-convention lint's test files share: running the gate, a
// throwaway repository, and the hold's workflows with one part varied.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const gate = join(import.meta.dir, "check-workflow-conventions.ts");

export function run(args: string[], env: Record<string, string> = {}) {
  const { GITHUB_ACTIONS: _, ...inherited } = process.env;
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    env: { ...inherited, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

/** The temporary roots a test made. */
const roots: string[] = [];
/** Removes them: each test file calls this after each test. */
export function cleanRoots() {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
}
export const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-conventions-"));
  roots.push(root);
  return root;
};

/** A throwaway repository holding `files`, for cases that vary one line. */
export function repo(files: Record<string, string>): string {
  const root = tempRoot();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
export const CONC = `concurrency:\n  group: ci-\${{ github.ref }}\n  cancel-in-progress: true\n`;
export const LABELS = "github.event.pull_request.labels.*.name";
/** The trigger of a workflow that honours the hold: both label transitions
 * beside the three types a trigger without `types:` runs on. */
export const PR_HOLD =
  "on:\n  pull_request:\n    types: [opened, synchronize, reopened, labeled, unlabeled]\n";
/** `expectSpawnExit` over `run`'s result, so a wrong exit code prints the
 * gate's own output. */
export const exits = (
  result: ReturnType<typeof run>,
  expected: number,
  label?: string,
) =>
  expectSpawnExit(
    { exitCode: result.code, stdout: result.out, stderr: result.err },
    expected,
    label,
  );

/** A pull-request workflow whose required `verdict` job needs a heavy `e2e`
 * job; `e2eIf` is e2e's condition and `stepIf` the condition of verdict's
 * failing step. */
export function holdRepo(label: string, e2eIf: string, stepIf: string) {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "${label}"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - ci.yml#e2e\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/ci.yml e2e\n",
    ".github/workflows/ci.yml": `${PR_HOLD}${CONC}jobs:\n  e2e:\n    if: "${e2eIf}"\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n  verdict:\n    needs: [e2e]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - if: "${stepIf}"\n        run: exit 1\n`,
  });
}
export const rulesOf = (err: string) =>
  [...new Set([...err.matchAll(/: \[([a-z-]+)\] /g)].map((m) => m[1]))].sort();

export const job = (id: string, extra = "") =>
  `  ${id}:\n    runs-on: x\n    timeout-minutes: 5\n${extra}    steps:\n      - run: make ${id}\n`;
export const SENTINEL_STEP = `      - if: contains(${LABELS}, 'hold')\n        run: exit 1\n`;

/** A pull-request workflow under the trigger `on`, with a guarded heavy
 * `e2e` and a required `verdict` carrying the sentinel: the hold's shape
 * except for the trigger under test. */
export function holdTrigger(on: string) {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "hold"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - ci.yml#e2e\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/ci.yml e2e\n",
    ".github/workflows/ci.yml": `${on}${CONC}jobs:\n  e2e:\n    if: \${{ !contains(${LABELS}, 'hold') }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n  verdict:\n    needs: [e2e]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${SENTINEL_STEP}      - run: make verdict\n`,
  });
}
