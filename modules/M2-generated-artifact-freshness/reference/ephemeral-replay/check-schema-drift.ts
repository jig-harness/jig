import { registerSignalHandler } from "../../../../plugin/shared/cleanup.ts";
import { poll, PollTimeoutError } from "../../../../plugin/shared/retry.ts";
// Docker/Postgres replay skeleton. Engine normalization remains consumer-owned.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { walk } from "../../../../lib/files.ts";
export function normalizeSchema(content: string): string {
  let previous = false;
  return (
    content
      .replace(/\n$/, "")
      .split("\n")
      .filter((line) => !/^(--|SET |SELECT pg_catalog.set_config)/.test(line))
      .map((line) => line.trimEnd())
      .filter((line) => {
        const keep = !!line || previous;
        previous = !!line;
        return keep;
      })
      .join("\n") + "\n"
  );
}
export type DockerRunner = (
  args: string[],
  input?: string,
  required?: boolean,
  signal?: AbortSignal,
) => Promise<string>;
class DockerTimeout extends Error {}
const operationTimeout = () => Number(process.env.DOCKER_TIMEOUT_MS) || 300000;
const READY_TIMEOUT_MS = 60000;
const CLEANUP_TIMEOUT_MS = 15000;
// Reconciliation after an unfinished `docker run`: wait up to five steps for
// the call to settle, then remove and list up to five times, one step apart,
// all within one overall deadline.
const RECONCILE_ATTEMPTS = 5;
const RECONCILE_DEADLINE_MS = 30000;
const DEFAULT_RECONCILE_STEP_MS = 1000;
const MAX_RECONCILE_STEP_MS = 10000;
// An integer number of milliseconds, clamped to 1..10000; anything else falls
// back to the default.
export function reconcileStepMs(raw = process.env.DOCKER_RECONCILE_MS): number {
  if (raw === undefined || raw === "") return DEFAULT_RECONCILE_STEP_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(
      `note: ignoring DOCKER_RECONCILE_MS=${raw}; using ${DEFAULT_RECONCILE_STEP_MS}ms`,
    );
    return DEFAULT_RECONCILE_STEP_MS;
  }
  return Math.min(value, MAX_RECONCILE_STEP_MS);
}
export async function checkSchema(
  migrations?: string,
  committed?: string,
  runner?: DockerRunner,
): Promise<number> {
  if (!migrations || !committed)
    throw new Error(
      "usage: check-schema-drift.ts <migrations-dir> <committed-schema.sql>",
    );
  if (!existsSync(committed))
    throw new Error(`committed schema not found: ${committed}`);
  const files = walk(migrations, []).filter(
    (name) =>
      !name.includes("/") && !name.includes("\\") && name.endsWith(".sql"),
  );
  // Unique per invocation: concurrent runs, even in the same checkout, never
  // share (or force-remove) each other's container.
  const container = `ephemeral-replay-${process.pid}-${randomBytes(4).toString("hex")}`;
  const step = reconcileStepMs();
  const cancel = new AbortController();
  // The `docker run` call settles after its deadline or an interrupt has already
  // given up on it, and the daemon may still create the container afterwards.
  let creation: Promise<boolean> | undefined;
  let created: boolean | undefined;
  const runResolved = () => created === true;
  // Every docker call has its own deadline and is also cancelled on interrupt;
  // the child process is killed when its signal aborts.
  async function docker(
    args: string[],
    input?: string,
    required = true,
    timeoutMs = operationTimeout(),
    cancellable = true,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = cancellable
      ? AbortSignal.any([timeout, cancel.signal])
      : timeout;
    const run = runner
      ? runner(args, input, required, signal)
      : (async () => {
          const child = Bun.spawn(["docker", ...args], {
            stdin:
              input === undefined ? "ignore" : new TextEncoder().encode(input),
            stdout: "pipe",
            stderr: "pipe",
            signal,
          });
          const [out, err, status] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          if (required && status)
            throw new Error(`docker ${args[0]} failed: ${err}`);
          return out + (args[0] === "logs" ? err : "");
        })();
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          timeout.aborted
            ? new DockerTimeout(
                `docker ${args[0]} timed out after ${timeoutMs}ms`,
              )
            : new Error(`docker ${args[0]} interrupted`),
        );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    if (args[0] === "run")
      creation = run.then(
        () => (created = true),
        () => (created = false),
      );
    run.catch(() => {});
    try {
      return await Promise.race([run, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  await docker(["version"]);
  // Cleanup is bounded and never masks the error that triggered it. When the
  // `docker run` call did not finish cleanly, the container may still appear
  // after the first removal, so it waits (bounded) for that call to settle, then
  // removes and lists until a successful listing shows the container absent
  // and the call has settled, or the attempts or the deadline run out.
  const cleanup = async () => {
    if (process.env.KEEP_CONTAINER) return;
    const warn = (error: unknown) =>
      console.error(
        `warning: could not remove ${container}: ${error instanceof Error ? error.message : error}`,
      );
    const deadline = Date.now() + RECONCILE_DEADLINE_MS;
    const budget = () =>
      Math.max(1, Math.min(CLEANUP_TIMEOUT_MS, deadline - Date.now()));
    const remove = () =>
      docker(["rm", "-f", container], undefined, true, budget(), false);
    if (!creation || runResolved()) {
      try {
        await remove();
      } catch (error) {
        warn(error);
      }
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      creation,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.min(5 * step, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    // Only a `run` call that resolved proves the container exists and can be
    // confirmed gone. A pending, rejected or cancelled call says nothing about
    // the daemon, which may still create the container after any listing, so
    // those outcomes end the bounded window with a warning even when every
    // listing was empty.
    let attempt = 0;
    let confirmedGone = false;
    try {
      await poll(
        async () => {
          attempt++;
          let gone = false;
          try {
            await remove();
            const left = await docker(
              ["ps", "-a", "--quiet", "--filter", `name=^/${container}$`],
              undefined,
              true,
              budget(),
              false,
            );
            gone = !left.trim();
          } catch (error) {
            warn(error);
          }
          confirmedGone = gone && runResolved();
          return (
            confirmedGone ||
            attempt === RECONCILE_ATTEMPTS ||
            Date.now() + step >= deadline
          );
        },
        {
          everyMs: step,
          deadlineMs: deadline,
          immediate: true,
          until: (done) => done,
        },
      );
    } catch (error) {
      if (!(error instanceof PollTimeoutError)) throw error;
    }
    if (confirmedGone) return;

    console.error(
      `warning: ${container} may still exist; remove it manually with: docker rm -f ${container}`,
    );
  };
  using cancellation = registerSignalHandler(() => {
    cancel.abort();
    return cleanup().finally(() => process.exit(2));
  });
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      container,
      "--env",
      "POSTGRES_PASSWORD=postgres",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_DB=postgres",
      process.env.PG_IMAGE || "postgres:18",
    ]);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const remaining = () =>
      Math.min(operationTimeout(), Math.max(1, deadline - Date.now()));
    try {
      await poll(
        async () => {
          try {
            const logs = await docker(
              ["logs", container],
              undefined,
              false,
              remaining(),
            );
            return logs.includes(
              "PostgreSQL init process complete; ready for start up.",
            );
          } catch (error) {
            // A probe that outruns the shared deadline is the deadline passing.
            if (error instanceof DockerTimeout) throw new PollTimeoutError();
            throw error;
          }
        },
        {
          everyMs: 500,
          deadlineMs: deadline,
          signal: cancel.signal,
          until: (ready) => ready,
        },
      );
    } catch (error) {
      if (error instanceof PollTimeoutError)
        throw new Error("Postgres init did not complete within 60s");
      throw error;
    }
    try {
      await poll(
        async () => {
          try {
            await docker(
              [
                "exec",
                container,
                "pg_isready",
                "-U",
                "postgres",
                "-d",
                "postgres",
              ],
              undefined,
              true,
              remaining(),
            );
            return true;
          } catch (error) {
            if (cancel.signal.aborted) throw error;
            // A probe that outruns the shared deadline is the deadline passing.
            if (error instanceof DockerTimeout) throw new PollTimeoutError();
            return false;
          }
        },
        {
          everyMs: 500,
          deadlineMs: deadline,
          signal: cancel.signal,
          // The log wait may use the whole shared deadline; readiness is still
          // probed once.
          immediate: true,
          until: (ready) => ready,
        },
      );
    } catch (error) {
      if (error instanceof PollTimeoutError)
        throw new Error("Postgres did not become ready within 60s");
      throw error;
    }
    for (const file of files)
      await docker(
        [
          "exec",
          "-i",
          "--env",
          "PGPASSWORD=postgres",
          container,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-X",
          "-q",
        ],
        readFileSync(join(migrations, file), "utf8"),
      );
    const fresh = await docker([
      "exec",
      "--env",
      "PGPASSWORD=postgres",
      container,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-tablespaces",
      "--no-security-labels",
    ]);
    if (
      normalizeSchema(fresh) !==
      normalizeSchema(readFileSync(committed, "utf8"))
    ) {
      console.error(`DRIFT: ${committed} is out of sync with a clean replay`);
      return 1;
    }
    console.log("OK: committed schema matches a clean replay");
    return 0;
  } finally {
    cancellation[Symbol.dispose]();
    await cleanup();
  }
}
if (import.meta.main) cli(() => checkSchema(...process.argv.slice(2)));
