/** The wrapper waits for a separately running supervisor; only the supervisor publishes the stage's exit. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export function spawnSupervisor(id: string, token: string): Promise<number> {
  return new Promise((settle) => {
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
      { stdio: "inherit", detached: true },
    );
    const forward = (name: NodeJS.Signals) => {
      child.kill(name);
    };
    for (const name of SIGNALS) process.on(name, forward);
    const finish = (code: number) => {
      for (const name of SIGNALS) process.off(name, forward);
      settle(code);
    };
    child.on("error", (error) => {
      console.error(`jig dispatch run: ${error.message}`);
      finish(127);
    });
    child.on("exit", (code) => finish(code ?? 1));
  });
}
