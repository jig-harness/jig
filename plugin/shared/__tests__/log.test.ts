/**
 * The logger, the error helpers and the command-line boundary, each run in a
 * subprocess so `JIG_LOG` and `JIG_LOG_FORMAT` are set for that process only.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../guarded-git-spawn.ts";
import { errnoCode } from "../errors.ts";

const shared = join(import.meta.dir, "..");

/** This process's environment without git's leaky variables or `JIG_LOG*`. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG_LOG")
    )
      env[key] = value;
  return env;
}

function run(source: string, extra: Record<string, string> = {}) {
  const env = cleanEnv();
  // Each "@shared/<file>" specifier becomes a quoted, escaped absolute path,
  // so a Windows path's backslashes are not read as string escapes.
  const script = source.replace(/"@shared\/([^"]+)"/g, (_, file: string) =>
    JSON.stringify(join(shared, file)),
  );
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

const EVERY_LEVEL = `
import { log, setLogScript } from "@shared/log.ts";
setLogScript("probe");
log.error("e"); log.warn("w"); log.info("i"); log.debug("d");
`;

describe("log", () => {
  test("writes warn and error by default, to standard error only", () => {
    const r = run(EVERY_LEVEL);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("probe: e\nprobe: w\n");
  });

  test("JIG_LOG sets the least severe level written", () => {
    expect(run(EVERY_LEVEL, { JIG_LOG: "error" }).stderr).toBe("probe: e\n");
    expect(run(EVERY_LEVEL, { JIG_LOG: "debug" }).stderr).toBe(
      "probe: e\nprobe: w\nprobe: i\nprobe: d\n",
    );
    expect(run(EVERY_LEVEL, { JIG_LOG: "loud" }).stderr).toBe(
      "probe: e\nprobe: w\n",
    );
  });

  test("text puts short fields after the message and long ones below it", () => {
    const r = run(`
import { log, setLogScript } from "@shared/log.ts";
setLogScript("probe");
log.warn("retrying", { attempt: 2, of: "gh api", body: "one\\ntwo" });
`);
    expect(r.stderr).toBe(
      "probe: retrying attempt=2 of=gh api\n  body:\n    one\n    two\n",
    );
  });

  test("JIG_LOG_FORMAT=json writes one object per line", () => {
    const r = run(
      `
import { log, setLogScript } from "@shared/log.ts";
setLogScript("probe");
log.warn("retrying", { attempt: 2, error: new Error("x", { cause: new Error("y") }) });
`,
      { JIG_LOG_FORMAT: "json" },
    );
    const entry: unknown = JSON.parse(r.stderr);
    expect(entry).toMatchObject({
      level: "warn",
      script: "probe",
      message: "retrying",
      attempt: 2,
      error: { name: "Error", message: "x", cause: { message: "y" } },
    });
    expect((entry as { time: string }).time).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );
  });
});

describe("log never throws", () => {
  const AWKWARD = `
import { log, setLogScript } from "@shared/log.ts";
setLogScript("probe");
const circular: Record<string, unknown> = { name: "loop" };
circular.self = circular;
const deep = new Error("e0");
let at = deep;
for (let i = 1; i < 50; i++) { const next = new Error("e" + i); (at as { cause?: unknown }).cause = next; at = next; }
(at as { cause?: unknown }).cause = deep;
log.warn("awkward", { circular, big: 10n, fn: () => 1, sym: Symbol("s"), deep });
console.log("survived");
`;

  test("in text format", () => {
    const r = run(AWKWARD);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("survived\n");
    expect(r.stderr).toStartWith("probe: awkward");
    expect(r.stderr).toContain("big=10");
  });

  test("in json format, where fields cannot overwrite the fixed keys", () => {
    const r = run(
      `${AWKWARD}\nlog.warn("real", { level: "forged", message: "forged", script: "forged", time: "forged" });`,
      { JIG_LOG_FORMAT: "json" },
    );
    expect(r.code).toBe(0);
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first: unknown = JSON.parse(lines[0] ?? "");
    expect(first).toMatchObject({ message: "awkward", big: "10" });
    const second: unknown = JSON.parse(lines[1] ?? "");
    expect(second).toMatchObject({
      level: "warn",
      message: "real",
      script: "probe",
    });
    expect((second as { time: string }).time).not.toBe("forged");
  });
});

describe("errors", () => {
  test("swallow writes the dropped error at debug level only", () => {
    const source = `
import { setLogScript } from "@shared/log.ts";
import { swallow } from "@shared/errors.ts";
setLogScript("probe");
swallow(new Error("unreadable"), "reading the cache fresh");
`;
    expect(run(source).stderr).toBe("");
    const debug = run(source, { JIG_LOG: "debug" }).stderr;
    expect(debug).toStartWith("probe: reading the cache fresh\n  error:\n");
    expect(debug).toContain("Error: unreadable");
  });

  test("swallow keeps the dropped error's cause and a failed child's output", () => {
    const debug = run(
      `
import { setLogScript } from "@shared/log.ts";
import { swallow } from "@shared/errors.ts";
setLogScript("probe");
const child = Object.assign(new Error("gh api exited 1"), { stderrTail: "HTTP 502" });
swallow(new Error("cache read failed", { cause: child }), "reading fresh");
`,
      { JIG_LOG: "debug" },
    ).stderr;
    expect(debug).toContain("  cause:\n    Error: gh api exited 1");
    expect(debug).toContain("  stderrTail:\n    HTTP 502");
  });

  test("errnoCode reads a system error's code", () => {
    expect(errnoCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(
      "ENOENT",
    );
    expect(errnoCode(new Error("x"))).toBeUndefined();
    expect(errnoCode({ code: 2 })).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
  });
});

describe("the command-line boundary", () => {
  const THROWS = `
import { runMain } from "@shared/cli.ts";
runMain("probe", async () => { throw new Error("it broke"); });
`;

  test("reports an unexpected error as <name>: <message> and exits 1", () => {
    const r = run(THROWS);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("probe: it broke\n");
  });

  test("prints the stack under JIG_LOG=debug", () => {
    const r = run(THROWS, { JIG_LOG: "debug" });
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith(
      "probe: it broke\nprobe: stack\n  error:\n    Error: it broke\n",
    );
    expect(r.stderr).toMatch(/\n\s+at /);
  });

  test("the exit code survives a logger that throws", () => {
    const r = run(
      `
import { failFrom, runMain } from "@shared/cli.ts";
process.stderr.write = () => { throw new Error("stderr is gone"); };
runMain("probe", async () => failFrom(new Error("x"), 11));
`,
      { JIG_LOG: "debug" },
    );
    expect(r.code).toBe(11);
    const withLines = run(`
import { fail, failFrom, runMain } from "@shared/cli.ts";
console.error = () => { throw new Error("stderr is gone"); };
runMain("probe", async () => failFrom(new Error("x"), 11, "probe: refused"));
`);
    expect(withLines.code).toBe(11);
    const plain = run(`
import { fail, runMain } from "@shared/cli.ts";
console.error = () => { throw new Error("stderr is gone"); };
runMain("probe", async () => fail(12, "probe: refused"));
`);
    expect(plain.code).toBe(12);
    const thrown = run(`
import { runMain } from "@shared/cli.ts";
process.stderr.write = () => { throw new Error("stderr is gone"); };
runMain("probe", async () => { throw new Error("boom"); });
`);
    expect(thrown.code).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "a closed standard error does not end the process",
    () => {
      // `true` exits at once, closing the pipe standard error writes to; the
      // EPIPE arrives later, on the stream's error event.
      const source = `
import { log, setLogScript } from ${JSON.stringify(join(shared, "log.ts"))};
setLogScript("probe");
await Bun.sleep(300);
for (let i = 0; i < 20; i++) { log.warn("line " + i + " " + "x".repeat(1000)); await Bun.sleep(10); }
process.stdout.write("survived\\n");
`;
      const r = spawnSync(
        "bash",
        [
          "-c",
          // `$PIPESTATUS` is the pipeline's first status: the script's own.
          '"$0" -e "$1" 2>&1 >/dev/null | true; echo "exit=$PIPESTATUS"',
          process.execPath,
          source,
        ],
        { env: cleanEnv(), encoding: "utf8", timeout: 30_000 },
      );
      expect(String(r.stdout).trim()).toBe("exit=0");
    },
  );

  test("a failing standard error after the last line ends nothing", () => {
    // The stream reports a failed write on its error event, after the write
    // has returned: the logger's lines and a refusal's lines alike.
    const fault = (code: string) =>
      `setTimeout(() => process.stderr.emit("error", Object.assign(new Error("write failed"), { code: ${JSON.stringify(code)} })), 50);`;
    for (const code of ["EPIPE", "ENOSPC", "EIO"]) {
      const logged = run(`
import { log } from "@shared/log.ts";
log.warn("a line");
${fault(code)}
setTimeout(() => process.stdout.write("survived\\n"), 150);
`);
      expect(logged.code).toBe(0);
      expect(logged.stdout).toBe("survived\n");
      const refused = run(`
import { fail, runMain } from "@shared/cli.ts";
runMain("probe", async () => fail(11, "probe: refused"));
${fault(code)}
`);
      expect(refused.code).toBe(11);
    }
  });

  test("an exit error keeps its code and stays quiet unless debugging", () => {
    const source = `
import { failFrom, runMain } from "@shared/cli.ts";
runMain("probe", async () => failFrom(new Error("the cause"), 3, "probe: refused"));
`;
    const quiet = run(source);
    expect(quiet.code).toBe(3);
    expect(quiet.stderr).toBe("probe: refused\n");
    const debug = run(source, { JIG_LOG: "debug" });
    expect(debug.code).toBe(3);
    expect(debug.stderr).toContain("probe: exit 3\n  error:\n    ExitError");
    expect(debug.stderr).toContain("  cause:\n    Error: the cause");
  });
});
