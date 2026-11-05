import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobFiles } from "../../runtime/scheduler.ts";
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
    expect(config("runtime_timeout: 721h\n")).toThrow("at most 24d");
  });

  it("refuses limits whose tick budget together passes the timer range", () => {
    expect(config("workspace_timeout: 576h\nruntime_timeout: 1m\n")).toThrow(
      "longer than 24d",
    );
    expect(
      config("workspace_timeout: 1h\nruntime_timeout: 1m\n")(),
    ).not.toBeNull();
  });

  it("refuses two names for one identity", () => {
    const read = config(
      `accounts:\n${account("a", "me@example.com")}${account("b", "ME@example.com")}`,
    );
    expect(read).toThrow("an account identity listed twice");
  });
});

describe("the machine file's shared records and owner", () => {
  const repo = (extra = "") =>
    `repositories:\n  - {path: /tmp/web, stages: [rearm]${extra}}\n`;
  const read = (body: string) =>
    config(body)() as {
      repositories: Array<{ owner: boolean }>;
      sharedRecords: string;
    };

  it("owns a repository and shares on the forge unless the file says otherwise", () => {
    const machine = read(repo());
    expect(machine.repositories[0]?.owner).toBe(true);
    expect(machine.sharedRecords).toBe("forge");
    expect(read(repo(", owner: false")).repositories[0]?.owner).toBe(false);
    expect(read(`records:\n  shared: forge\n`).sharedRecords).toBe("forge");
  });

  it("refuses an owner that is not true or false, and a medium or key it does not know", () => {
    expect(config(repo(", owner: maybe"))).toThrow(
      "repositories[0].owner must be true or false",
    );
    expect(config("records:\n  shared: control-plane\n")).toThrow(
      "records.shared must be one of forge",
    );
    expect(config("records:\n  board: forge\n")).toThrow(
      "records has unknown key(s): board",
    );
  });
});

describe("the machine file's account directories", () => {
  it("refuses two accounts for one vendor and configuration directory", () => {
    const read = config(
      `accounts:\n${account("a", "me@example.com")}${account("b", "you@example.com", "a")}`,
    );
    expect(read).toThrow("an account configuration directory listed twice");
  });
});

describe("the timer's cadence", () => {
  const job = { command: ["x"], env: {} };
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
