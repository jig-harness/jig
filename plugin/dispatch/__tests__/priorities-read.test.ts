/**
 * The repository record as the tick reads it from `origin/<default>` with
 * local git: a reference problem the record can resolve itself blocks
 * allocation and one to another level does not, a removed file is no record,
 * and a git failure is reported as one rather than as a missing file.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../shared/guarded-git-spawn.ts";
import { PRIORITIES_FILE } from "../../shared/priorities/record.ts";
import { dump } from "../../shared/yaml.ts";
import { readRepositoryRecord } from "../lib/priorities-read.ts";

const NOW = Date.parse("2026-11-18T08:00:00Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-priorities-read-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, env: withoutLeakyGitEnv(process.env) },
  );
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
}

/** A checkout whose `origin/main` holds each of `revisions` in turn (`null` removes the file). */
function checkout(revisions: Array<unknown | null>): string {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".config"));
  revisions.forEach((value, i) => {
    if (value === null) git(dir, "rm", "-q", PRIORITIES_FILE);
    else {
      writeFileSync(join(dir, PRIORITIES_FILE), dump(value));
      git(dir, "add", PRIORITIES_FILE);
    }
    git(dir, "commit", "-q", "-m", `revision ${i}`);
  });
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function record(refs: Array<{ level: string; scope: string; id: string }>) {
  return {
    level: "repository",
    scope: "acme/widgets",
    revision: 1,
    objectives: [
      {
        id: "ship",
        class: "core",
        purpose: "p",
        endState: "e",
        owner: "maintainers",
        refs,
      },
    ],
  };
}

describe("the repository record's read", () => {
  it("blocks allocation on a reference its own record should hold, and not on one to another level", () => {
    const own = readRepositoryRecord(
      checkout([
        record([{ level: "repository", scope: "acme/widgets", id: "nope" }]),
      ]),
      "main",
      NOW,
    );
    expect(own.record).toBeNull();
    expect(own.blocked).toContain(
      "references repository:acme/widgets:nope, which no record read holds",
    );
    const other = readRepositoryRecord(
      checkout([record([{ level: "site", scope: "acme", id: "goal" }])]),
      "main",
      NOW,
    );
    expect(other.blocked).toBeNull();
    expect(other.record?.objectives[0]?.id).toBe("ship");
  });

  it("reads a revision that removed the file as no record", () => {
    const read = readRepositoryRecord(
      checkout([record([{ level: "site", scope: "acme", id: "goal" }]), null]),
      "main",
      NOW,
    );
    expect(read).toMatchObject({
      record: null,
      source: `no ${PRIORITIES_FILE} on origin/main`,
      blocked: null,
    });
  });

  it("reports a git failure with git's own words, not as a missing file", () => {
    const read = readRepositoryRecord(scratch(), "main", NOW);
    expect(read.record).toBeNull();
    expect(read.source).toMatch(
      /^origin\/main could not be read: git log exited \d+: .+/,
    );
  });
});

describe("the read's completeness", () => {
  it("is incomplete when git cannot answer, so an absent record is no evidence of none", () => {
    const read = readRepositoryRecord(scratch(), "main", NOW);
    expect(read.record).toBeNull();
    expect(read.complete).toBe(false);
  });
});
