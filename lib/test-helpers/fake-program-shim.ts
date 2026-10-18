// The body of the executable a Windows fake program is (see fake-program.ts).
// Compiled once per test process, then hard-linked beside every fake program.
// It runs the interpreter and script its sidecar names, with this process's
// environment and standard streams, and exits with the child's status.
//
// Git Bash's runtime does not hand a script the arguments its caller passed.
// It parses the Windows command line itself, so a quote inside an argument
// splits it, expands globs and braces (`repos/{owner}/{repo}` arrives as
// `repos/owner/repo`), and turns arguments that look like Unix paths into
// Windows paths. A shell fake therefore gets its arguments out of band, in
// `JIG_FAKE_ARG_<n>` variables that a prologue fake-program.ts puts into the
// fake turns back into `"$@"`. (A quote in a `-c` string, or in the arguments
// of a shell that `exec`s another, is mangled the same way.) A Bun fake, which
// parses the command line as this program does, is passed its arguments
// directly.
import { readFileSync } from "node:fs";

/** The suffix of the sidecar record that sits beside a fake's executable. */
export const SIDECAR_SUFFIX = ".fake.json";

interface Sidecar {
  interpreter: string;
  kind: "sh" | "bash" | "bun";
  script: string;
}

function isSidecar(value: unknown): value is Sidecar {
  if (typeof value !== "object" || value === null) return false;
  const { interpreter, kind, script } = value as Record<string, unknown>;
  return (
    typeof interpreter === "string" &&
    typeof script === "string" &&
    (kind === "sh" || kind === "bash" || kind === "bun")
  );
}

function run({ interpreter, kind, script }: Sidecar): number {
  const args = process.argv.slice(2);
  const env: Record<string, string | undefined> = { ...process.env };
  if (kind !== "bun") {
    Object.assign(env, {
      JIG_FAKE_ARGC: String(args.length),
      MSYS: `${process.env.MSYS ?? ""} noglob`.trim(),
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
      MSYS2_ENV_CONV_EXCL: "JIG_FAKE_*",
    });
    args.forEach((arg, index) => {
      env[`JIG_FAKE_ARG_${index}`] = arg;
    });
  }
  const child = Bun.spawnSync(
    [interpreter, script, ...(kind === "bun" ? args : [])],
    { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  return child.exitCode ?? 1;
}

function main(): void {
  const sidecar = `${process.execPath.replace(/\.exe$/i, "")}${SIDECAR_SUFFIX}`;
  const spec: unknown = JSON.parse(readFileSync(sidecar, "utf8"));
  if (isSidecar(spec)) {
    process.exitCode = run(spec);
  } else {
    process.stderr.write(
      `fake program: ${sidecar} is not a fake-program record\n`,
    );
    process.exitCode = 127;
  }
}

// Imported by fake-program.ts for the constant above; runs only as the
// compiled executable's entry point.
if (import.meta.main) main();
