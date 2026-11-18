/** Start a headless wrapper outside the scheduled tick's service. */
import { closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { detectScheduler } from "../../../runtime/scheduler.ts";
import { run } from "../../../shared/proc.ts";
import { currentMs } from "../../../shared/time.ts";
import { stateRoot } from "../../receipts.ts";
import { readRecord } from "../launches.ts";
import type { LaunchStage, RuntimeReceipt } from "./port.ts";
import {
  processEnvironment,
  type ProcessSettings,
} from "./process-environment.ts";
import { openProcessStartupLog } from "./process-spool.ts";
import { offerProcessRequest } from "./process-ipc.ts";
import {
  launchdCommand,
  processJobName,
  windowsCommand,
} from "./process-service.ts";

const BUNFIG = resolve(import.meta.dir, "../../bunfig.toml");
const RUN = resolve(import.meta.dir, "../../run.ts");

async function detached(
  id: string,
  argv: string[],
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const log = openProcessStartupLog(id);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(argv[0] as string, argv.slice(1), {
      cwd: import.meta.dir,
      detached: true,
      env: {},
      stdio: ["ignore", "ignore", log],
    });
  } finally {
    closeSync(log);
  }
  child.unref();
  return new Promise((settle) => {
    const timer = setTimeout(
      () =>
        settle({
          ok: false,
          lost: true,
          detail: "the process launcher did not answer within its deadline",
        }),
      timeoutMs,
    );
    const finish = (receipt: RuntimeReceipt) => {
      clearTimeout(timer);
      settle(receipt);
    };
    child.once("spawn", () =>
      finish({ ok: true, detail: "started a detached process session" }),
    );
    child.once("error", () =>
      finish({ ok: false, detail: "the detached process could not start" }),
    );
  });
}

async function submit(
  id: string,
  argv: string[],
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const scheduler = detectScheduler();
  if (scheduler.ok && scheduler.value === "cron")
    return detached(id, argv, timeoutMs);
  const clean = ["/usr/bin/env", "-i", ...argv];
  const command =
    process.platform === "win32"
      ? windowsCommand(id, argv)
      : scheduler.ok && scheduler.value === "launchd"
        ? launchdCommand(id, clean)
        : scheduler.ok && scheduler.value === "systemd"
          ? [
              "/usr/bin/systemd-run",
              "--user",
              `--unit=${processJobName(id)}`,
              "--collect",
              "--property=Type=exec",
              "--",
              ...clean.map((arg) => arg.replace(/\$/g, () => "$$")),
            ]
          : null;
  if (command === null)
    return {
      ok: false,
      detail: "no process service manager is supported on this host",
    };
  const done = await run(command, {
    cwd: import.meta.dir,
    timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
    stderr: "pipe",
  });
  if (done.timedOut)
    return {
      ok: false,
      lost: true,
      detail: "the process service manager did not answer before its deadline",
    };
  return done.code === 0
    ? { ok: true, detail: `started process run ${processJobName(id)}` }
    : {
        ok: false,
        lost: true,
        detail: `the process service manager did not confirm the run (exit ${done.code})`,
      };
}

export async function launchProcess(
  workspace: { path: string },
  stage: LaunchStage,
  account: string,
  token: string,
  settings: ProcessSettings,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  if (stage.kind !== "headless")
    return {
      ok: false,
      detail: "the process runtime does not run interactive sessions",
    };
  try {
    const record = readRecord(stage.record);
    if (
      record?.runtime !== "process" ||
      record.token !== token ||
      record.account !== account ||
      record.workspace?.path !== workspace.path
    )
      return {
        ok: false,
        detail: "the process launch does not match its record",
      };
    const until = currentMs() + timeoutMs;
    const env = processEnvironment(process.env, settings, record, record.id);
    const request = await offerProcessRequest(
      { id: record.id, token, workspace: workspace.path, env },
      timeoutMs,
    );
    if (!request.ok) return { ok: false, detail: request.failure.reason };
    try {
      const left = until - currentMs();
      if (left < 1)
        return {
          ok: false,
          detail: "the process request spent the launch deadline",
        };
      const argv = [
        process.execPath,
        "--no-env-file",
        `--config=${BUNFIG}`,
        RUN,
        "process-entry",
        request.value.address,
        record.id,
        stateRoot(),
      ];
      const submitted = await submit(record.id, argv, left);
      if (!submitted.ok) return submitted;
      return (await request.value.accepted)
        ? submitted
        : {
            ok: false,
            lost: true,
            detail:
              "the service manager acknowledged the run but the wrapper did not accept its request",
          };
    } finally {
      request.value.close();
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
