/**
 * What a failing `gh` call leaves for the person reading the run: by default
 * the script's own message and `gh`'s output; under `JIG_LOG=debug` also the
 * stack of the exit, its causes and the last 4 KiB of `gh`'s error output, as
 * the command-line boundary (`shared/cli.ts`) reports them. Each case runs a
 * shipped script in a subprocess with a fake `gh` first on its `PATH`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { STDERR_TAIL_BYTES } from "../../../shared/proc.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "resolve-thread.ts");
const FIRST_LINE = "first line of the error output";
const LAST_LINE = "gh: last line of the error output";

// A `gh` that fails with more error output than the tail keeps.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' '${FIRST_LINE}' >&2
i=0
while [ $i -lt 200 ]; do
  printf 'filler line %03d of the error output\\n' $i >&2
  i=$((i+1))
done
printf '%s\\n' '${LAST_LINE}' >&2
exit 4
`;

let dir: string;
let bin: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "debug-log-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runScript(extra: Record<string, string>, ghDir = bin) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG_LOG") &&
      !key.startsWith("DRIVE_PR_")
    )
      env[key] = value;
  const r = spawnSync(process.execPath, [SCRIPT, "PRRT_x"], {
    cwd: dir,
    env: {
      ...env,
      GH_CALL_TIMEOUT: "20",
      ...extra,
      PATH: `${ghDir}${delimiter}${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, stderr: String(r.stderr) };
}

/** The lines of a multi-line field in the text format, unindented. */
function textField(stderr: string, key: string): string | undefined {
  const match = new RegExp(`\\n {2}${key}:\\n((?: {4}.*\\n?)+)`).exec(stderr);
  return match?.[1]
    ?.split("\n")
    .map((line) => line.slice(4))
    .join("\n")
    .trimEnd();
}

describe.skipIf(process.platform === "win32")("a failing gh call", () => {
  test("by default reports the failure without a stack", () => {
    const r = runScript({});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read owning PR liveness");
    expect(r.stderr).toContain(LAST_LINE);
    expect(r.stderr).not.toContain("stderrTail");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  test("under JIG_LOG=debug prints the stack, the causes and the stderr tail", () => {
    const r = runScript({ JIG_LOG: "debug" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("resolve-thread: exit 1");
    const error = textField(r.stderr, "error");
    expect(error).toStartWith("ExitError: exit 1");
    expect(error).toMatch(/\n\s*at /);
    expect(textField(r.stderr, "cause")).toStartWith("ExitError: exit 4");
    expect(textField(r.stderr, "cause2")).toStartWith(
      "ChildFailure: gh api exited 4",
    );
    const tail = textField(r.stderr, "stderrTail");
    expect(tail).toBeDefined();
    expect(tail).toEndWith(LAST_LINE);
    expect(tail).not.toContain(FIRST_LINE);
    expect(Buffer.byteLength(tail ?? "")).toBeLessThanOrEqual(
      STDERR_TAIL_BYTES,
    );
  });

  test("under JIG_LOG_FORMAT=json writes the same as one JSON object", () => {
    const r = runScript({ JIG_LOG: "debug", JIG_LOG_FORMAT: "json" });
    expect(r.code).toBe(1);
    const line = r.stderr
      .split("\n")
      .find((l) => l.startsWith("{") && l.includes('"stderrTail"'));
    expect(line).toBeDefined();
    const entry: unknown = JSON.parse(line ?? "{}");
    expect(entry).toMatchObject({
      level: "debug",
      script: "resolve-thread",
      message: "exit 1",
      error: { name: "ExitError", cause: { name: "ExitError" } },
    });
    const { stderrTail, error } = entry as {
      stderrTail: string;
      error: { stack: string };
    };
    expect(stderrTail.trimEnd()).toEndWith(LAST_LINE);
    expect(Buffer.byteLength(stderrTail)).toBeLessThanOrEqual(
      STDERR_TAIL_BYTES,
    );
    expect(error.stack).toMatch(/\n\s*at /);
  });

  test("killed at its deadline, prints the tail of its error output by default", () => {
    const slow = join(dir, "slow-bin");
    mkdirSync(slow, { recursive: true });
    writeFileSync(
      join(slow, "gh"),
      "#!/bin/sh\nprintf 'gh: still waiting on the API\\n' >&2\nexec sleep 30\n",
    );
    chmodSync(join(slow, "gh"), 0o755);
    const r = runScript(
      { GH_CALL_TIMEOUT: "1", RRC_DEADLINE_GRACE_MS: "10" },
      slow,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("killed after 1000ms");
    expect(r.stderr).toContain("gh: still waiting on the API");
    expect(r.stderr).not.toContain("stderrTail");
  });

  test("an answer that is not JSON names what was read, under JIG_LOG=debug", () => {
    const garbled = join(dir, "garbled-bin");
    mkdirSync(garbled, { recursive: true });
    writeFileSync(join(garbled, "gh"), "#!/bin/sh\necho '<html>'\n");
    chmodSync(join(garbled, "gh"), 0o755);
    const r = runScript({ JIG_LOG: "debug" }, garbled);
    expect(r.code).toBe(1);
    expect(textField(r.stderr, "cause")).toStartWith(
      "DecodeError: the owning pull request of thread PRRT_x: $ is not JSON",
    );
  });
});
