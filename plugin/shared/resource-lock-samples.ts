/** Completed runs of the machine-wide resource lock, kept for seven days. */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMapping } from "./config-layers.ts";
import { swallow } from "./errors.ts";
import { currentMs, parseMs } from "./time.ts";

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SAMPLE_FILE = /^(\d{1,16})-[0-9a-f-]{36}\.json$/;

export interface ResourceLockSample {
  name: string;
  workspace: string;
  requestedAt: string;
  waitMs: number;
  holdMs: number;
}

function sampleDirectory(env: NodeJS.ProcessEnv): string {
  const home =
    (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  return join(home, ".local", "state", "jig", "resource-lock-samples");
}

function sampleEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      swallow(error, "resource lock samples are unavailable");
    return [];
  }
}

function releaseTime(entry: string): number {
  return Number(SAMPLE_FILE.exec(entry)?.[1]);
}

/** Publish a distinct sample after releasing the lock; telemetry failures never change the run's exit. */
export function recordResourceLockSample(
  sample: ResourceLockSample,
  releasedAt: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = sampleDirectory(env);
  const path = join(dir, `${releasedAt}-${crypto.randomUUID()}.json`);
  const staged = `${path}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      staged,
      JSON.stringify({ kind: "resource-lock-sample", v: 1, ...sample }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    renameSync(staged, path);
    for (const entry of sampleEntries(dir)) {
      if (
        releaseTime(entry.endsWith(".json.tmp") ? entry.slice(0, -4) : entry) <
        releasedAt - KEEP_MS
      )
        rmSync(join(dir, entry), { force: true });
    }
  } catch (error) {
    swallow(error, "resource lock samples could not be recorded or pruned");
  }
}

function readSample(path: string, name: string): ResourceLockSample | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isMapping(data) ||
      data.kind !== "resource-lock-sample" ||
      data.v !== 1 ||
      data.name !== name
    )
      return null;
    const { workspace, requestedAt, waitMs, holdMs } = data;
    if (
      typeof workspace !== "string" ||
      !workspace ||
      typeof requestedAt !== "string" ||
      !Number.isFinite(parseMs(requestedAt)) ||
      typeof waitMs !== "number" ||
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      typeof holdMs !== "number" ||
      !Number.isFinite(holdMs) ||
      holdMs <= 0
    )
      return null;
    return { name, workspace, requestedAt, waitMs, holdMs };
  } catch (error) {
    swallow(error, "this resource lock sample could not be read");
    return null;
  }
}

export function readResourceLockSamples(
  name: string,
  nowMs = currentMs(),
  env: NodeJS.ProcessEnv = process.env,
): ResourceLockSample[] {
  const dir = sampleDirectory(env);
  const samples: ResourceLockSample[] = [];
  for (const entry of sampleEntries(dir)) {
    const at = releaseTime(entry);
    if (at >= nowMs - KEEP_MS && at <= nowMs) {
      const sample = readSample(join(dir, entry), name);
      if (sample !== null) samples.push(sample);
    }
  }
  return samples;
}
