/**
 * Run a Bun snippet in a child process whose `PATH` starts with a directory
 * holding a stand-in `gh`, from that directory, with the variables a real
 * `gh` would pick its account or endpoint from removed. A test that needs the
 * child's environment changed does it here, never in its own process.
 */
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "./fake-program.ts";

export interface FakeGhRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runWithFakeGh(opts: {
  /** An existing scratch directory; the stand-in `gh` is written into it. */
  dir: string;
  /** The stand-in's source, shebang first. */
  gh: string;
  /** The snippet `bun -e` runs. */
  code: string;
  /** Variables removed from the child's environment. */
  unset: string[];
}): Promise<FakeGhRun> {
  writeFakeProgram(join(opts.dir, "gh"), opts.gh);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${opts.dir}${delimiter}${process.env.PATH ?? ""}`,
  };
  for (const name of opts.unset) delete env[name];
  const child = Bun.spawn([process.execPath, "-e", opts.code], {
    cwd: opts.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
