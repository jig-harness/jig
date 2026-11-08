import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobFiles } from "../../runtime/scheduler.ts";
import { dispatchJobSpec } from "../install.ts";
import {
  type MachineConfig,
  readMachineConfig,
  tickBudgetMs,
  tickDeadlineMs,
} from "../lib/machine-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

/** The machine file `body` holds, as `readMachineConfig` reads it. */
function config(body: string): ReturnType<typeof readMachineConfig> {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-config-"));
  dirs.push(dir);
  const file = join(dir, "dispatch.yaml");
  writeFileSync(file, body);
  return readMachineConfig(file);
}

/** The machine file `body` holds, which the test expects to read. */
function machine(body: string): MachineConfig {
  const read = config(body);
  if (!read.ok) throw new Error(read.failure.reason);
  if (read.value === null) throw new Error("no machine file was read");
  return read.value;
}

/** The refusal of a value that does not validate, its reason containing `reason`. */
const invalid = (reason: string) =>
  ({
    ok: false,
    failure: { code: "invalid", reason: expect.stringContaining(reason) },
  }) as const;

const account = (name: string, identity: string, dir = name) =>
  `  - {name: ${name}, vendor: claude, config_dir: /tmp/${dir}, identity: ${identity}}\n`;

describe("the machine file's bounds", () => {
  it("keeps a launch open beside the notices reservation", () => {
    expect(
      config(
        "opens_per_tick: 1\nrepositories:\n  - {path: /tmp/web, stages: [notify]}\n",
      ),
    ).toEqual(invalid("opens_per_tick must be at least 2"));
    expect(machine("opens_per_tick: 1\n")).not.toBeNull();
  });

  it("defaults to four workspace opens and budgets configured opens in the timer", () => {
    expect(machine("").opensPerTick).toBe(4);
    const read = machine(
      "opens_per_tick: 8\nworkspace_timeout: 1h\nruntime_timeout: 1m\n",
    );
    expect(read.opensPerTick).toBe(8);
    expect(tickBudgetMs(read)).toBe(8 * 3_600_000 + 8 * 60_000);
    expect(tickDeadlineMs(read)).toBe(tickBudgetMs(read));
    expect(dispatchJobSpec(5, read).deadlineSec).toBe(
      Math.ceil(tickBudgetMs(read) / 1000),
    );
  });

  it("refuses invalid open counts and a count whose workspace opens exceed the timer", () => {
    for (const value of ["0", "-1", "1.5", "many"])
      expect(config(`opens_per_tick: ${value}\n`)).toEqual(
        invalid("opens_per_tick must be a positive whole number"),
      );
    expect(config("opens_per_tick: 1000\nworkspace_timeout: 1h\n")).toEqual(
      invalid("opens_per_tick"),
    );
    expect(config("opens_per_tick: 1000\nworkspace_timeout: 1h\n")).toEqual(
      invalid("longer than 24d"),
    );
  });

  it("refuses a duration past the supported range, however large", () => {
    expect(config("wall_backoff: 999999999999999999999999h\n")).toEqual(
      invalid("at most 24d"),
    );
    expect(config("runtime_timeout: 721h\n")).toEqual(invalid("at most 24d"));
  });

  it("refuses limits whose tick budget together passes the timer range", () => {
    expect(config("workspace_timeout: 576h\nruntime_timeout: 1m\n")).toEqual(
      invalid("longer than 24d"),
    );
    expect(
      machine("workspace_timeout: 1h\nruntime_timeout: 1m\n"),
    ).not.toBeNull();
  });

  it("refuses two names for one identity", () => {
    const read = config(
      `accounts:\n${account("a", "me@example.com")}${account("b", "ME@example.com")}`,
    );
    expect(read).toEqual(invalid("an account identity listed twice"));
  });
});

describe("the machine file's shared records and owner", () => {
  const repo = (extra = "") =>
    `repositories:\n  - {path: /tmp/web, stages: [rearm]${extra}}\n`;

  it("owns a repository and shares on the forge unless the file says otherwise", () => {
    const read = machine(repo());
    expect(read.repositories[0]?.owner).toBe(true);
    expect(read.sharedRecords).toBe("forge");
    expect(machine(repo(", owner: false")).repositories[0]?.owner).toBe(false);
    expect(machine(`records:\n  shared: forge\n`).sharedRecords).toBe("forge");
  });

  it("refuses an owner that is not true or false, and a medium or key it does not know", () => {
    expect(config(repo(", owner: maybe"))).toEqual(
      invalid("repositories[0].owner must be true or false"),
    );
    expect(config("records:\n  shared: control-plane\n")).toEqual(
      invalid("records.shared must be one of forge"),
    );
    expect(config("records:\n  board: forge\n")).toEqual(
      invalid("records has unknown key(s): board"),
    );
  });
});

describe("the machine file's send switch", () => {
  it("lets jig send write unless the file says send: false, and refuses anything but true or false", () => {
    expect(machine("").send).toBe(true);
    expect(machine("send: true\n").send).toBe(true);
    expect(machine("send: false\n").send).toBe(false);
    expect(config("send: never\n")).toEqual(
      invalid("send must be true or false"),
    );
  });
});

describe("the machine file's account directories", () => {
  it("refuses two accounts for one vendor and configuration directory", () => {
    const read = config(
      `accounts:\n${account("a", "me@example.com")}${account("b", "you@example.com", "a")}`,
    );
    expect(read).toEqual(
      invalid("an account configuration directory listed twice"),
    );
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
