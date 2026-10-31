import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobFiles } from "../../gc/scheduler.ts";
import { dispatchJobSpec } from "../install.ts";
import { readMachineConfig } from "../lib/machine-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function config(body: string): () => unknown {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-config-"));
  dirs.push(dir);
  const file = join(dir, "dispatch.yaml");
  writeFileSync(file, body);
  return () => readMachineConfig(file);
}

const account = (name: string, identity: string, dir = name) =>
  `  - {name: ${name}, vendor: claude, config_dir: /tmp/${dir}, identity: ${identity}}\n`;

describe("the machine file's bounds", () => {
  it("refuses a duration past the supported range, however large", () => {
    expect(config("wall_backoff: 999999999999999999999999h\n")).toThrow(
      "at most 24d",
    );
    expect(config("runtime_timeout: 31d\n")).toThrow();
  });

  it("refuses two names for one identity", () => {
    const read = config(
      `accounts:\n${account("a", "me@example.com")}${account("b", "ME@example.com")}`,
    );
    expect(read).toThrow("an account identity listed twice");
  });
});

describe("the timer's cadence", () => {
  const job = { command: ["x"], env: {}, hour: 3 };
  const cron = (minutes: number) =>
    jobFiles("cron", { ...job, spec: dispatchJobSpec(minutes) }).crontab;

  it("keeps an interval that divides the hour or the day", () => {
    expect(cron(5)).toStartWith("*/5 * * * * ");
    expect(cron(120)).toStartWith("0 */2 * * * ");
  });

  it("refuses one a crontab step would run at the wrong cadence", () => {
    expect(() => cron(7)).toThrow("cannot run every 7 minutes");
    expect(() => cron(90)).toThrow("cannot run every 90 minutes");
  });
});
