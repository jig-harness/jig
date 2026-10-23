import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * Bun's test runner can lose every event of the first child process a test
 * file starts asynchronously through `node:child_process` once the file's
 * hooks and tests run: the child runs and exits, but neither `exit`, `close`
 * nor its pipes' `end` is ever emitted, so whatever waits on it waits out its
 * own deadline. Seen on macOS under CPU load with Bun 1.4.4, in roughly one
 * file in ten at a load of eight runnable processes per core; `bun run` and
 * the child the file starts next are not affected.
 *
 * A file whose first child process is the one under test awaits this in its
 * `beforeAll`, so a throwaway child takes that place. It waits for the
 * throwaway's `close` until `boundMs` and then leaves it unreferenced, so a
 * lost event costs that bound once per file and never holds the process open.
 */
export function spendFirstSpawn(
  boundMs = 5_000,
  spawn: (command: string, args: string[]) => ChildProcess = (command, args) =>
    nodeSpawn(command, args, { stdio: ["ignore", "ignore", "inherit"] }),
): Promise<"closed" | "lost"> {
  const child = spawn(process.execPath, ["--version"]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.unref();
      resolve("lost");
    }, boundMs);
    const closed = () => {
      clearTimeout(timer);
      resolve("closed");
    };
    child.once("close", closed);
    child.once("error", closed);
  });
}
