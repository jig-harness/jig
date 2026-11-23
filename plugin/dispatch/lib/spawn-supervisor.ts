/** The wrapper waits for a separately running supervisor; only the supervisor publishes the stage's exit. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { openSpool } from "./runtime/process-spool.ts";
import { failureText } from "./text.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** `env` is the supervisor's environment: the wrapper's own, or what `supervisorEnvironment` makes of it for a provider account's launch (`provider-launch.ts`). */
export function spawnSupervisor(
  id: string,
  token: string,
  processRuntime = false,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  return new Promise((settle) => {
    let spool: ReturnType<typeof openSpool> | undefined;
    const closeSpool = () => {
      try {
        spool?.close();
      } catch (error) {
        console.error(
          `jig dispatch run: the output spool could not be closed: ${failureText(error)}`,
        );
      }
      spool = undefined;
    };
    const writeFailed = (error: unknown) => {
      closeSpool();
      console.error(
        `jig dispatch run: the output spool could not be written: ${failureText(error)}`,
      );
    };
    if (processRuntime) {
      try {
        spool = openSpool(id, writeFailed);
      } catch (error) {
        console.error(
          `jig dispatch run: the output spool could not be opened: ${failureText(error)}`,
        );
      }
    }
    const save = (chunk: Buffer) => {
      try {
        spool?.write(chunk);
      } catch (error) {
        writeFailed(error);
      }
    };
    const child = spawn(
      process.execPath,
      [
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        resolve(import.meta.dir, "../run.ts"),
        "supervise",
        id,
        token,
      ],
      {
        stdio: processRuntime ? ["ignore", "pipe", "pipe"] : "inherit",
        detached: true,
        env,
      },
    );
    child.stdout?.on("data", save);
    child.stderr?.on("data", save);
    const forward = (name: NodeJS.Signals) => {
      child.kill(name);
    };
    for (const name of SIGNALS) process.on(name, forward);
    const finish = (code: number) => {
      for (const name of SIGNALS) process.off(name, forward);
      closeSpool();
      settle(code);
    };
    child.on("error", (error) => {
      console.error(`jig dispatch run: ${error.message}`);
      finish(127);
    });
    child.on(processRuntime ? "close" : "exit", (code) => finish(code ?? 1));
  });
}
