/** Completed runs of the machine-wide resource lock, kept for seven days. */
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
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
const MAX_SAMPLE_BYTES = 32 * 1024;
const MAX_SAMPLES = 10_000;

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

function retainedEntries(dir: string, nowMs: number): string[] {
  return sampleEntries(dir)
    .filter((entry) => {
      if (!SAMPLE_FILE.test(entry)) return false;
      const releasedAt = releaseTime(entry);
      return releasedAt >= nowMs - KEEP_MS && releasedAt <= nowMs;
    })
    .sort((left, right) => releaseTime(right) - releaseTime(left));
}

function recentEntries(dir: string, nowMs: number): string[] {
  return retainedEntries(dir, nowMs).slice(0, MAX_SAMPLES);
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
    const entries = sampleEntries(dir);
    for (const entry of entries) {
      if (
        releaseTime(entry.endsWith(".json.tmp") ? entry.slice(0, -4) : entry) <
        releasedAt - KEEP_MS
      )
        rmSync(join(dir, entry), { force: true });
    }
    const retained = retainedEntries(dir, releasedAt);
    for (const entry of retained.slice(MAX_SAMPLES))
      rmSync(join(dir, entry), { force: true });
  } catch (error) {
    swallow(error, "resource lock samples could not be recorded or pruned");
  }
}

function readSampleText(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SAMPLE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_SAMPLE_BYTES);
    const read = readSync(fd, buffer, 0, MAX_SAMPLE_BYTES, 0);
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

function isSampleEnvelope(
  data: unknown,
  name: string,
): data is Record<string, unknown> {
  return (
    isMapping(data) &&
    data.kind === "resource-lock-sample" &&
    data.v === 1 &&
    data.name === name
  );
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(parseMs(value));
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sampleDetails(
  data: Record<string, unknown>,
): Omit<ResourceLockSample, "name"> | null {
  const { workspace, requestedAt, waitMs, holdMs } = data;
  if (!isNonemptyText(workspace)) return null;
  if (!isTimestamp(requestedAt)) return null;
  if (!isNonnegativeNumber(waitMs)) return null;
  if (!isPositiveNumber(holdMs)) return null;
  return { workspace, requestedAt, waitMs, holdMs };
}

function sampleFrom(data: unknown, name: string): ResourceLockSample | null {
  if (!isSampleEnvelope(data, name)) return null;
  const details = sampleDetails(data);
  if (details === null) return null;
  return { name, ...details };
}

function readSample(path: string, name: string): ResourceLockSample | null {
  try {
    const text = readSampleText(path);
    return text === null ? null : sampleFrom(JSON.parse(text), name);
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
  for (const entry of recentEntries(dir, nowMs)) {
    const at = releaseTime(entry);
    if (at >= nowMs - KEEP_MS && at <= nowMs) {
      const sample = readSample(join(dir, entry), name);
      if (sample !== null) samples.push(sample);
    }
  }
  return samples;
}
