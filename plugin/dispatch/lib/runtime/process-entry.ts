/** A service-manager bootstrap. The wrapper receives only its checked request. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { LAUNCH_RECORD_ID } from "../../../shared/records/launch-claims.ts";
import { readProcessRequest } from "./process-ipc.ts";
import { retireProcessJob } from "./process-service.ts";

async function startWrapper(
  address: string,
  id: string,
  root: string,
): Promise<number> {
  const request = await readProcessRequest(address, id, root);
  if (!request.ok) {
    console.error(
      "jig dispatch process: the launch request could not be verified",
    );
    return 2;
  }
  const { token, workspace, env } = request.value;
  const child = spawn(
    process.execPath,
    [
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../../bunfig.toml")}`,
      resolve(import.meta.dir, "../../run.ts"),
      id,
      token,
    ],
    { cwd: workspace, env, stdio: ["ignore", "ignore", "inherit"] },
  );
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of signals) process.on(signal, forward);
  const code = await new Promise<number>((done) => {
    child.once("error", () => {
      console.error("jig dispatch process: the checked wrapper did not start");
      done(127);
    });
    child.once("close", (exit) => done(exit ?? 1));
  });
  for (const signal of signals) process.off(signal, forward);
  return code;
}

export async function runProcessEntry(
  address: string,
  id: string,
  root: string,
): Promise<number> {
  if (!LAUNCH_RECORD_ID.test(id)) return 2;
  try {
    return await startWrapper(address, id, root);
  } catch {
    console.error(
      "jig dispatch process: the checked wrapper could not be prepared",
    );
    return 2;
  } finally {
    // A bootstrap with an expired or refused request has no wrapper to
    // write an exit. It still owns the scheduler job and must retire it.
    try {
      const problem = await retireProcessJob(id, 5);
      if (problem !== null) console.error(`jig dispatch process: ${problem}`);
    } catch {
      console.error("jig dispatch process: could not retire the completed job");
    }
  }
}
