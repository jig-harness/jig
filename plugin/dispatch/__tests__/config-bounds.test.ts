import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobFiles } from "../../runtime/scheduler.ts";
import { dispatchJobSpec } from "../install.ts";
import {
  readMachineConfig,
  tickBudgetMs,
  tickDeadlineMs,
} from "../lib/machine-config.ts";

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
  it("keeps a launch open beside the notices reservation", () => {
    expect(
      config(
        "opens_per_tick: 1\nrepositories:\n  - {path: /tmp/web, stages: [notify]}\n",
      ),
    ).toThrow("opens_per_tick must be at least 2");
    expect(config("opens_per_tick: 1\n")()).not.toBeNull();
  });

  it("defaults to four workspace opens and budgets configured opens in the timer", () => {
    expect((config("")() as { opensPerTick: number }).opensPerTick).toBe(4);
    const machine = config(
      "opens_per_tick: 8\nworkspace_timeout: 1h\nruntime_timeout: 1m\n",
    )() as NonNullable<ReturnType<typeof readMachineConfig>>;
    expect(machine.opensPerTick).toBe(8);
    // The follow-ups' lane adds its two default opens.
    expect(tickBudgetMs(machine)).toBe((8 + 2) * 3_600_000 + 8 * 60_000);
    expect(tickDeadlineMs(machine)).toBe(tickBudgetMs(machine));
    expect(dispatchJobSpec(5, machine).deadlineSec).toBe(
      Math.ceil(tickBudgetMs(machine) / 1000),
    );
  });

  it("refuses invalid open counts and a count whose workspace opens exceed the timer", () => {
    for (const value of ["0", "-1", "1.5", "many"])
      expect(config(`opens_per_tick: ${value}\n`)).toThrow(
        "opens_per_tick must be a positive whole number",
      );
    expect(config("opens_per_tick: 1000\nworkspace_timeout: 1h\n")).toThrow(
      "opens_per_tick",
    );
    expect(config("opens_per_tick: 1000\nworkspace_timeout: 1h\n")).toThrow(
      "longer than 24d",
    );
  });

  it("reads the follow-ups' lane with its defaults, and counts its opens in the tick's budget", () => {
    type Lane = { followupOpensPerTick: number; followupConcurrency: number };
    const defaults = config("")() as Lane;
    expect(defaults.followupOpensPerTick).toBe(2);
    expect(defaults.followupConcurrency).toBe(2);
    const machine = config(
      "opens_per_tick: 4\nfollowup_opens_per_tick: 3\nfollowup_concurrency: 5\nworkspace_timeout: 1h\nruntime_timeout: 1m\n",
    )() as NonNullable<ReturnType<typeof readMachineConfig>>;
    expect(machine.followupOpensPerTick).toBe(3);
    expect(machine.followupConcurrency).toBe(5);
    expect(tickBudgetMs(machine)).toBe((4 + 3) * 3_600_000 + 8 * 60_000);
    expect(tickDeadlineMs(machine)).toBe(tickBudgetMs(machine));
  });

  it("refuses an invalid lane value, and lane opens that push the tick past the timer, naming the field", () => {
    for (const field of ["followup_opens_per_tick", "followup_concurrency"])
      for (const value of ["0", "-1", "1.5", "many"])
        expect(config(`${field}: ${value}\n`)).toThrow(
          `${field} must be a positive whole number`,
        );
    // Four launch opens of an hour fit; six hundred more from the lane do not.
    expect(config("workspace_timeout: 1h\n")()).not.toBeNull();
    const read = config(
      "followup_opens_per_tick: 600\nworkspace_timeout: 1h\n",
    );
    expect(read).toThrow("followup_opens_per_tick 600 pushes a tick past 24d");
  });

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

describe("the machine file's send switch", () => {
  const read = (body: string) => config(body)() as { send: boolean };

  it("lets jig send write unless the file says send: false, and refuses anything but true or false", () => {
    expect(read("").send).toBe(true);
    expect(read("send: true\n").send).toBe(true);
    expect(read("send: false\n").send).toBe(false);
    expect(config("send: never\n")).toThrow("send must be true or false");
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
