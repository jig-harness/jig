/**
 * What the launch tests add to a tick's world: the machine file, accounts
 * whose configuration directories the drive's resolver reads, launch
 * records and walls written straight into the child's state directory, and
 * polling for what the wrapper leaves behind.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dump } from "../../shared/yaml.ts";
import {
  claimRecord,
  type LaunchRecord,
  type ProcessIdentity,
  recordExit,
  writeRecord,
} from "../lib/launches.ts";
import type { World } from "./fixtures.ts";

export interface Account {
  name: string;
  identity: string;
  dir: string;
}

export function dispatchState(w: World): string {
  return join(w.home, ".local", "state", "jig", "dispatch");
}

/** An account whose configuration directory resolves to `email`. */
export function account(w: World, name: string, email: string): Account {
  const dir = join(w.root, `config-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
  return { name, identity: email, dir };
}

/** The machine file: the world's repository with `rearm`, and these accounts. */
export function machineFile(
  w: World,
  accounts: Array<Account & { max?: number }>,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(join(w.home, ".jig"), { recursive: true });
  writeFileSync(
    join(w.home, ".jig", "dispatch.yaml"),
    dump({
      repositories: [{ path: w.repo, stages: ["rearm"] }],
      accounts: accounts.map((a) => ({
        name: a.name,
        vendor: "claude",
        config_dir: a.dir,
        identity: a.identity,
        ...(a.max === undefined ? {} : { max_per_account: a.max }),
      })),
      ...extra,
    }),
  );
}

/** A launch record as an earlier tick wrote it. */
export function earlierRecord(
  w: World,
  fields: Partial<LaunchRecord> & Pick<LaunchRecord, "id" | "account">,
): LaunchRecord {
  const record: LaunchRecord = {
    version: 1,
    token: "earlier-token",
    action: "rearm",
    repo: "example-org/example-repo",
    repoPath: w.repo,
    pr: 7,
    vendor: "claude",
    configDir: join(w.root, `config-${fields.account}`),
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt: "2026-10-30T20:00:00.000Z",
    workspace: { id: "repo-1::/ws/0", path: w.repo },
    attempts: [],
    ...fields,
  };
  writeRecord(record, dispatchState(w));
  return record;
}

export function claimed(
  w: World,
  id: string,
  identity: ProcessIdentity,
  exit?: number,
): void {
  claimRecord(id, identity, dispatchState(w));
  if (exit !== undefined)
    recordExit(
      id,
      { at: "2026-10-30T21:00:00.000Z", code: exit, signal: null },
      dispatchState(w),
    );
}

/** Poll until `check` holds, failing past the deadline. */
export async function waitFor(
  what: string,
  check: () => boolean,
  deadlineMs = 20_000,
): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** The runs the fake drive recorded. */
export function driveRuns(w: World): Array<{
  argv: string[];
  cwd: string;
  configDir: string | null;
  token: string | null;
}> {
  const path = join(w.dir, "drive-runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** Every `orca terminal create` the fake Orca answered, by its arguments. */
export function terminalCreates(w: World): string[][] {
  const path = join(w.dir, "orca-calls.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === "terminal" && args[1] === "create");
}

/** The ids of the launch records in the child's state directory. */
export function recordIds(w: World): string[] {
  const dir = join(dispatchState(w), "launches");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -".json".length))
    : [];
}

export function exitWritten(w: World, id: string): boolean {
  return existsSync(join(dispatchState(w), "launches", `${id}.exit`));
}
