/**
 * A fake program on `PATH`: how a test stands in for `gh`, `git`, `claude`
 * and the like the same way on every platform.
 *
 * `writeFakeProgram(path, source)` takes what the test used to write itself, a
 * script whose first line is its shebang (`#!/bin/sh`, `#!/usr/bin/env bash`
 * or `#!/usr/bin/env bun`), and leaves a program a spawn finds by the bare name
 * of `path`.
 *
 * - On POSIX the script is the program: written to `path`, owner-executable.
 * - On Windows a shebang means nothing, and a `.cmd` wrapper does not do
 *   either: `Bun.spawn(["gh"])` resolves only `.exe` names, so a `gh.cmd` is
 *   ignored, and a real `gh.exe` later on `PATH` runs in its place. The program
 *   is a small executable, `path.exe`, that runs the script's interpreter on
 *   `path.fake` with the caller's arguments, environment and streams. The
 *   executable is one compiled Bun program (`fake-program-shim.ts`), built once
 *   per test process into its scoped temp dir and hard-linked (copied when a
 *   link is refused) beside each fake.
 *
 * The interpreter is resolved when the fake is written, from this process's
 * `PATH`, so a test that later narrows the `PATH` it hands a child does not
 * hide the interpreter from the fake. `sh` and `bash` are Git for Windows'
 * (Git Bash), the shell Jig's Windows support targets; a machine without it
 * fails here with a message that says so.
 *
 * A fake is not a place to test a signal or a process group: on Windows the
 * script runs in a child of the executable, which a kill of the executable does
 * not reach. Such a test stays POSIX-only.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SIDECAR_SUFFIX } from "./fake-program-shim.ts";

const SHIM_SOURCE = join(import.meta.dir, "fake-program-shim.ts");

/** A fake program that cannot be written on this machine. */
class FakeProgramError extends Error {}

/** The interpreters a fake's shebang may name, and how each is found. */
const INTERPRETERS = {
  sh: () => Bun.which("sh"),
  bash: () => Bun.which("bash"),
  bun: () => process.execPath,
} as const;

type Interpreter = keyof typeof INTERPRETERS;

/**
 * The interpreter a script's first line names. A shebang with options
 * (`#!/bin/sh -e`) is refused: the shim runs the interpreter on the script
 * alone, so on Windows the options would be dropped and the fake would
 * behave differently from the same script run directly on POSIX.
 */
export function shebangInterpreter(source: string): Interpreter {
  const first = source.split("\n", 1)[0] ?? "";
  const match =
    /^#!\s*(?:\S*[\\/]env\s+)?(?:\S*[\\/])?(sh|bash|bun)(?:\.exe)?\s*$/.exec(
      first,
    );
  if (!match) {
    throw new FakeProgramError(
      `a fake program starts with a #!/bin/sh, #!/usr/bin/env bash or #!/usr/bin/env bun line, without options, got ${JSON.stringify(first)}`,
    );
  }
  return match[1] as Interpreter;
}

/**
 * Put after a shell fake's shebang line: rebuilds `"$@"` from the
 * `JIG_FAKE_ARG_<n>` variables the shim sets (see fake-program-shim.ts for why
 * the arguments travel that way), then forgets them, so a fake that runs
 * itself (`"$0" pr view …`) gets the arguments of that call and not these.
 */
const SHELL_PROLOGUE = `if [ -n "\${JIG_FAKE_ARGC+x}" ]; then
  set --
  i=0
  while [ "$i" -lt "$JIG_FAKE_ARGC" ]; do
    eval "set -- \\"\\$@\\" \\"\\$JIG_FAKE_ARG_$i\\""
    i=$((i + 1))
  done
  unset JIG_FAKE_ARGC i
fi
`;

/** A shell fake with its argument prologue placed after the shebang line. */
function withPrologue(source: string): string {
  const newline = source.indexOf("\n");
  return newline === -1
    ? `${source}\n${SHELL_PROLOGUE}`
    : `${source.slice(0, newline + 1)}${SHELL_PROLOGUE}${source.slice(newline + 1)}`;
}

let shim: string | undefined;

/** The compiled shim, built on first use and reused by the rest of the process. */
function shimExecutable(): string {
  if (shim && existsSync(shim)) return shim;
  const dir = mkdtempSync(join(tmpdir(), "fake-program-shim-"));
  const built = join(dir, "shim.exe");
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", SHIM_SOURCE, "--outfile", built],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new FakeProgramError(
      `compiling the fake-program shim failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  shim = built;
  return shim;
}

/** `path` with its Windows executable extension; a name that has one keeps it. */
function executableName(path: string): string {
  return /\.exe$/i.test(path) ? path : `${path}.exe`;
}

/**
 * Writes the fake program `path` from `source`. The directory of `path` must
 * exist. Returns the file a spawn runs: `path` on POSIX, `path.exe` on Windows.
 * `shim: true` builds the Windows layout on any platform, for the tests of the
 * shim itself.
 */
export function writeFakeProgram(
  path: string,
  source: string,
  options: { shim?: boolean } = {},
): string {
  // Checked on every platform, so a fake that only Windows would reject fails
  // where it is written.
  const interpreter = shebangInterpreter(source);
  const shimmed = options.shim ?? process.platform === "win32";
  if (!shimmed) {
    writeFileSync(path, source, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  }
  const resolved = INTERPRETERS[interpreter]();
  if (!resolved) {
    throw new FakeProgramError(
      `a fake program needs ${interpreter} on PATH; install Git for Windows (Git Bash) and put its bin directory on PATH`,
    );
  }
  const exe = executableName(path);
  const base = exe.replace(/\.exe$/i, "");
  // Executable, so the fake can run itself through its own shebang.
  writeFileSync(
    `${base}.fake`,
    interpreter === "bun" ? source : withPrologue(source),
    { mode: 0o755 },
  );
  writeFileSync(
    `${base}${SIDECAR_SUFFIX}`,
    JSON.stringify({
      interpreter: resolved,
      kind: interpreter,
      script: `${base}.fake`,
    }),
  );
  // Replace rather than reuse: a test that writes the same fake twice means
  // the second body, and a hard link to the shim is cheap to remake.
  rmSync(exe, { force: true });
  mkdirSync(dirname(exe), { recursive: true });
  const master = shimExecutable();
  try {
    linkSync(master, exe);
  } catch {
    const staged = `${exe}.${process.pid}.tmp`;
    copyFileSync(master, staged);
    renameSync(staged, exe);
  }
  return exe;
}
