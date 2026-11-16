/**
 * A machine working in repositories owned by different GitHub accounts, with
 * a `gh` that picks its account per repository from the stored logins: each
 * repository's calls spend the allowance of the account the client picks for
 * it, and a hold on one account's allowance refuses only that account's calls.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { budgetGovernor, sqliteBudgetStore } from "../outbound/budget.ts";
import { unverifiedOwner, userOwner } from "../outbound/github-credential.ts";
import {
  type DiscoverUser,
  githubOwnerResolver,
  sqliteOwnerStore,
} from "../outbound/github-owner.ts";
import { refusedUser, setForgeGovernor } from "../outbound/github-budget.ts";
import { errorMessages } from "../outbound/github-refusal.ts";
import {
  apiRepo,
  ghRunScope,
  originRepo,
  repoFlag,
  repoOfName,
  repoOfRemote,
} from "../outbound/github-scope.ts";
import { ghRunFailure } from "../outbound/github.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import { closeDatabase } from "../records/db.ts";
import { currentMs } from "../time.ts";
import { traceGhRunner } from "../trace.ts";

type Env = Record<string, string | undefined>;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  held?: OutboundFailure;
}

interface Opts {
  env?: Env;
  cwd?: string;
  timeoutSec?: number;
}

const directories: string[] = [];
const databases: string[] = [];

afterEach(() => {
  setForgeGovernor(null);
  for (const path of databases.splice(0)) closeDatabase(path);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-forge-accounts-"));
  directories.push(dir);
  return dir;
}

function databasePath(): string {
  const path = join(scratch(), "budget.sqlite");
  databases.push(path);
  return path;
}

/** A client configuration directory whose `hosts.yml` names `user` as the active account. */
function configDir(user: string): string {
  const dir = scratch();
  writeFileSync(
    join(dir, "hosts.yml"),
    `github.com:\n    users:\n        alice:\n            oauth_token: x\n        bob:\n            oauth_token: y\n    git_protocol: https\n    user: ${user}\n`,
  );
  return dir;
}

/** A git repository whose `origin` remote is `url`. */
function repository(url: string): string {
  const dir = join(scratch(), "work");
  mkdirSync(dir);
  for (const argv of [
    ["git", "init", "--quiet", dir],
    ["git", "-C", dir, "remote", "add", "origin", url],
  ]) {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expectSpawnExit(result, 0, argv.join(" "));
  }
  return dir;
}

const ACCOUNTS: Record<string, { id: number; login: string }> = {
  alice: { id: 11, login: "alice" },
  bob: { id: 12, login: "bob" },
};

/** The account each environment token belongs to. */
const TOKENS: Record<string, string> = { "alice-token": "alice" };

/**
 * A discovery that answers as a client picking its account per repository
 * does: a token's own account, else by `GH_REPO`, else the stored login's
 * active account; counting its calls and the working directories it was
 * asked in.
 */
function picker(byRepo: Record<string, string>, active = () => "alice") {
  const asked: { env: Env; cwd: string | undefined }[] = [];
  const discover: DiscoverUser = async (env, _deadlineMs, cwd) => {
    asked.push({ env, cwd });
    const name =
      env.GH_TOKEN === undefined
        ? (byRepo[env.GH_REPO ?? ""] ?? active())
        : TOKENS[env.GH_TOKEN];
    const account = ACCOUNTS[name ?? ""];
    return account === undefined
      ? { failure: { code: "unauthorized", reason: "gh exited 1: HTTP 401" } }
      : { user: account };
  };
  return { discover, asked };
}

function processOn(path: string, discover: DiscoverUser) {
  const store = sqliteBudgetStore(path);
  const governor = budgetGovernor(store, { share: () => null });
  const owners = githubOwnerResolver({
    owners: sqliteOwnerStore(path),
    budget: store,
    governor,
    discover,
  });
  setForgeGovernor(governor, owners);
  return { store, governor, owners };
}

/** A forge client sending with `env` from `cwd`, whose `gh` is `answer`. */
function client(
  env: Env,
  cwd: string | undefined,
  answer: (argv: string[]) => Run = () => ok("{}"),
) {
  const sent: string[][] = [];
  const runner = traceGhRunner<Run, Opts>(
    async (argv) => {
      sent.push(argv);
      return answer(argv);
    },
    () => 10,
    { env },
    (failure) => ({
      code: 1,
      stdout: "",
      stderr: `${failure.reason}\n`,
      timedOut: false,
      held: failure,
    }),
  );
  return {
    run: (args: string[]) =>
      runner(args, { env, ...(cwd === undefined ? {} : { cwd }) }),
    sent,
  };
}

const ok = (stdout: string): Run => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

/** GitHub's refusal of a spent core limit, naming the user whose allowance it is. */
const spent = (userId: number): Run => ({
  code: 1,
  stdout: `HTTP/2.0 403 Forbidden\nx-ratelimit-resource: core\nx-ratelimit-limit: 5000\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${Math.floor((currentMs() + 3_600_000) / 1000)}\n\n{"message":"API rate limit exceeded for user ID ${userId}."}`,
  stderr: `gh: API rate limit exceeded for user ID ${userId}. (HTTP 403)\n`,
  timedOut: false,
});

const BY_REPO = { "example-org/one": "alice", "other-org/two": "bob" };

describe("a stored login whose client picks the account per repository", () => {
  it("does not refuse one repository's calls for another account's spent allowance (working directory)", async () => {
    const env = { GH_CONFIG_DIR: configDir("alice") };
    const one = repository("https://github.com/example-org/one.git");
    const two = repository("git@github.com:other-org/two.git");
    const { discover, asked } = picker(BY_REPO);
    const machine = processOn(databasePath(), discover);

    await client(env, one, () => spent(11)).run(["pr", "view", "1"]);
    const again = client(env, one);
    const held = await again.run(["pr", "view", "2"]);
    expect(again.sent).toHaveLength(0);
    expect(ghRunFailure(held)?.code).toBe("rate-limited");

    const other = client(env, two);
    expect((await other.run(["pr", "view", "1"])).code).toBe(0);
    expect(other.sent).toHaveLength(1);
    expect(
      machine.store.read(userOwner("github.com", 12))?.requests,
    ).not.toMatchObject({ remaining: 0 });
    // Each repository was asked who it is, in its own directory.
    expect(asked.map((a) => [a.env.GH_REPO, a.cwd])).toEqual([
      ["example-org/one", one],
      ["other-org/two", two],
    ]);
  });

  it("keys a repository a call names apart from the working directory's", async () => {
    const env = { GH_CONFIG_DIR: configDir("alice") };
    const one = repository("https://github.com/example-org/one.git");
    processOn(databasePath(), picker(BY_REPO).discover);

    await client(env, one, () => spent(11)).run([
      "api",
      "repos/example-org/one/pulls",
    ]);
    for (const args of [
      ["pr", "view", "1", "-R", "other-org/two"],
      ["api", "repos/other-org/two/pulls"],
      ["issue", "list", "--repo=github.com/other-org/two"],
    ]) {
      const other = client(env, one);
      expect((await other.run(args)).code).toBe(0);
      expect(other.sent).toHaveLength(1);
    }
    const held = client(env, one);
    await held.run(["pr", "view", "1"]);
    expect(held.sent).toHaveLength(0);
  });

  it("keeps the first page's repository for the pages a Link URL names", async () => {
    const env = { GH_CONFIG_DIR: configDir("alice") };
    const one = repository("https://github.com/example-org/one.git");
    const { discover, asked } = picker(BY_REPO);
    processOn(databasePath(), discover);
    const page = (link: string, body: string) =>
      ok(`HTTP/2.0 200 OK\n${link}\n\n${body}`);
    const other = client(env, one, (argv) =>
      argv.includes("repos/other-org/two/issues?per_page=100")
        ? page(
            'link: <https://api.github.com/repositories/123/issues?page=2>; rel="next"',
            "[1]",
          )
        : page("x-ratelimit-resource: core", "[2]"),
    );
    const read = await other.run([
      "api",
      "--paginate",
      "repos/other-org/two/issues",
    ]);
    expect(read.code).toBe(0);
    expect(other.sent).toHaveLength(2);
    // Neither page was charged to the working directory's repository.
    expect(asked.map((a) => a.env.GH_REPO)).toEqual(["other-org/two"]);
  });

  it("names the account whose allowance is spent when it refuses a call", async () => {
    const env = { GH_CONFIG_DIR: configDir("alice") };
    const two = repository("https://github.com/other-org/two");
    processOn(databasePath(), picker(BY_REPO).discover);

    await client(env, two, () => spent(12)).run(["pr", "view", "1"]);
    const refused = await client(env, two).run(["pr", "view", "2"]);
    const reason = ghRunFailure(refused)?.reason ?? "";
    expect(reason).toContain("(the allowance of GitHub account bob)");
    expect(reason).toEndWith("; nothing was sent");
  });
});

describe("a refusal that names another user than the cached owner", () => {
  it("holds the named user's allowance, not the cached owner's, and asks the owner again", async () => {
    const env = { GH_CONFIG_DIR: configDir("alice") };
    const one = repository("https://github.com/example-org/one.git");
    // The picker answered alice when asked, and has since moved the
    // repository to bob.
    let account = "alice";
    const { discover, asked } = picker({}, () => account);
    const machine = processOn(databasePath(), discover);
    await client(env, one).run(["pr", "view", "1"]);
    expect(asked).toHaveLength(1);
    account = "bob";

    const refused = await client(env, one, () => spent(12)).run([
      "pr",
      "view",
      "2",
    ]);
    expect(ghRunFailure(refused)?.code).toBe("rate-limited");
    expect(refused).toMatchObject({ limitedUntil: expect.any(Number) });
    expect(
      machine.store.read(userOwner("github.com", 12))?.requests.remaining,
    ).toBe(0);
    expect(
      machine.store.read(userOwner("github.com", 11))?.requests.remaining,
    ).not.toBe(0);

    // Another caller of the cached owner still sends.
    const alice = client({ GH_TOKEN: "alice-token" }, one);
    expect((await alice.run(["pr", "view", "3"])).code).toBe(0);
    expect(alice.sent).toHaveLength(1);

    // The repository's next call asks who it is again, and is held on bob's allowance.
    const next = client(env, one);
    const held = await next.run(["pr", "view", "4"]);
    expect(next.sent).toHaveLength(0);
    const repositoryAsks = asked.filter((a) => a.env.GH_TOKEN === undefined);
    expect(repositoryAsks.map((a) => a.env.GH_REPO)).toEqual([
      "example-org/one",
      "example-org/one",
    ]);
    expect(ghRunFailure(held)?.reason).toContain(
      "(the allowance of GitHub account bob)",
    );
  });
});

describe("a refusal that names the owner it was admitted against", () => {
  it("holds that owner and asks nothing again", async () => {
    const env = { GH_CONFIG_DIR: configDir("alice") };
    const one = repository("https://github.com/example-org/one.git");
    const { discover, asked } = picker(BY_REPO);
    const machine = processOn(databasePath(), discover);
    await client(env, one, () => spent(11)).run(["pr", "view", "1"]);
    expect(
      machine.store.read(userOwner("github.com", 11))?.requests.remaining,
    ).toBe(0);
    const next = client(env, one);
    await next.run(["pr", "view", "2"]);
    expect(next.sent).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });
});

describe("an environment token", () => {
  it("keeps one owner whatever repository it addresses", async () => {
    const one = repository("https://github.com/example-org/one.git");
    const two = repository("https://github.com/other-org/two.git");
    const { discover, asked } = picker(BY_REPO);
    processOn(databasePath(), discover);
    const env = { GH_TOKEN: "alice-token" };
    await client(env, one, () => spent(11)).run(["pr", "view", "1"]);
    const other = client(env, two);
    await other.run(["pr", "view", "1", "-R", "other-org/two"]);
    expect(other.sent).toHaveLength(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.env.GH_REPO).toBeUndefined();
  });
});

describe("a credential whose account is not established", () => {
  it("says its refusal is the host's shared record", async () => {
    const one = repository("https://github.com/example-org/one.git");
    const machine = processOn(databasePath(), picker({}).discover);
    const env = { GH_TOKEN: "unknown-token" };
    await client(env, one, () => ({
      code: 1,
      stdout:
        'HTTP/2.0 403 Forbidden\nRetry-After: 120\n\n{"message":"You have exceeded a secondary rate limit"}',
      stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)\n",
      timedOut: false,
    })).run(["pr", "view", "1"]);
    expect(
      machine.store.read(unverifiedOwner("github.com"))?.limitedUntil,
    ).toBeGreaterThan(currentMs());
    const refused = await client(env, one).run(["pr", "view", "2"]);
    expect(ghRunFailure(refused)?.reason).toEndWith(
      " (the shared record of the credentials whose account is not established on github.com); nothing was sent",
    );
  });
});

describe("the repository a run addresses", () => {
  it("reads every form of -R and --repo", () => {
    for (const args of [
      ["pr", "view", "1", "-R", "Example-Org/One"],
      ["pr", "view", "1", "-RExample-Org/One"],
      ["pr", "view", "1", "-R=example-org/one"],
      ["pr", "view", "1", "--repo", "example-org/one"],
      ["pr", "view", "1", "--repo=example-org/one"],
      ["pr", "view", "1", "-R", "github.example.com/example-org/one"],
      ["pr", "view", "1", "-R", "https://github.com/example-org/one.git"],
    ])
      expect(repoFlag(args)).toBe("example-org/one");
    expect(repoFlag(["pr", "list"])).toBeNull();
    expect(
      repoFlag(["issue", "create", "--body", "-Rnot-a-flag/x"]),
    ).toBeNull();
    expect(repoFlag(["pr", "view", "--", "-R", "example-org/one"])).toBeNull();
    expect(repoFlag(["pr", "view", "-R", "just-a-name"])).toBeNull();
    expect(
      repoFlag(["issue", "list", "--label", "-Rother-org/two"]),
    ).toBeNull();
    expect(
      repoFlag(["pr", "view", "https://github.com/Other-Org/Two/pull/1"]),
    ).toBe("other-org/two");
  });

  it("reads a positional repository URL only where it is a positional argument", () => {
    const url = "https://github.com/other-org/two/issues/1";
    // Content and API routes are not repository selectors.
    expect(
      repoFlag(["pr", "create", "--title", "fix", "--body", url]),
    ).toBeNull();
    expect(repoFlag(["issue", "create", "--label", url])).toBeNull();
    expect(
      repoFlag(["api", "https://api.github.com/repos/other-org/two/issues"]),
    ).toBeNull();
    expect(repoFlag(["issue", "view", "-w", url])).toBe("other-org/two");
    // A switch's alias does not hide the repository flag after it.
    expect(repoFlag(["pr", "review", "1", "-a", "-R", "other-org/two"])).toBe(
      "other-org/two",
    );
    expect(repoFlag(["pr", "merge", "1", "-r", "-R", "other-org/two"])).toBe(
      "other-org/two",
    );
  });

  it("reads a gh api route under repos/", () => {
    expect(apiRepo(["api", "repos/Example-Org/One/pulls?per_page=5"])).toBe(
      "example-org/one",
    );
    expect(apiRepo(["api", "-X", "GET", "/repos/example-org/one"])).toBe(
      "example-org/one",
    );
    expect(
      apiRepo(["api", "https://api.github.com/repos/example-org/one/issues"]),
    ).toBe("example-org/one");
    expect(apiRepo(["api", "repos/{owner}/{repo}/pulls"])).toBeNull();
    expect(apiRepo(["api", "user"])).toBeNull();
    expect(apiRepo(["pr", "view", "repos/example-org/one"])).toBeNull();
  });

  it("reads GH_REPO and remote URLs in every form", () => {
    expect(repoOfName("example-org/one")).toBe("example-org/one");
    expect(repoOfName("github.example.com/example-org/one")).toBe(
      "example-org/one",
    );
    expect(repoOfName("")).toBeNull();
    for (const url of [
      "https://github.com/example-org/one.git",
      "https://github.com/example-org/one",
      "https://user@github.com/example-org/one.git/",
      "git@github.com:example-org/one.git",
      "github.com:example-org/one",
      "git@account-alias:example-org/one.git",
      "ssh://git@github.com/example-org/one.git",
      "ssh://git@github.com:22/example-org/one",
    ])
      expect(repoOfRemote(url)).toBe("example-org/one");
    for (const url of [
      "/srv/git/one.git",
      "file:///srv/git/one.git",
      "C:\\repos\\one",
      "https://github.com/one",
      "",
    ])
      expect(repoOfRemote(url)).toBeNull();
  });

  it("reads the origin remote of a working directory, and none outside a repository", () => {
    const one = repository("git@github.com:Example-Org/One.git");
    expect(originRepo(one)).toBe("example-org/one");
    expect(originRepo(scratch())).toBeNull();
  });

  it("follows the default repository gh chose over origin", () => {
    const fork = repository("git@github.com:me/one.git");
    for (const argv of [
      [
        "git",
        "-C",
        fork,
        "remote",
        "add",
        "upstream",
        "git@github.com:Example-Org/One.git",
      ],
      ["git", "-C", fork, "config", "remote.upstream.gh-resolved", "base"],
    ])
      expectSpawnExit(
        Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }),
        0,
        argv.join(" "),
      );
    expect(originRepo(fork)).toBe("example-org/one");
  });

  it("takes the flag, then the api route, then GH_REPO, then the working directory", () => {
    const one = repository("https://github.com/example-org/one.git");
    const env = { GH_REPO: "other-org/two" };
    expect(
      ghRunScope(["api", "repos/third-org/three", "-R", "x/y"], env, one),
    ).toBe("x/y");
    expect(ghRunScope(["api", "repos/third-org/three"], env, one)).toBe(
      "third-org/three",
    );
    expect(ghRunScope(["pr", "list"], env, one)).toBe("other-org/two");
    expect(ghRunScope(["pr", "list"], {}, one)).toBe("example-org/one");
    expect(
      ghRunScope(["pr", "list", "-R", "x/y"], { GH_TOKEN: "t" }, one),
    ).toBeNull();
  });

  it("reads the user a refusal names", () => {
    expect(refusedUser("API rate limit exceeded for user ID 42.")).toBe(42);
    expect(
      refusedUser(
        "gh: API rate limit already exceeded for user ID 7. (HTTP 403)",
      ),
    ).toBe(7);
    expect(refusedUser("You have exceeded a secondary rate limit")).toBeNull();
  });

  it("reads a named user only from an error answer's own messages", () => {
    expect(
      refusedUser(
        errorMessages('{"message":"API rate limit exceeded for user ID 42."}'),
      ),
    ).toBe(42);
    expect(
      refusedUser(
        errorMessages(
          '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 9."}]}',
        ),
      ),
    ).toBe(9);
    // A page of content quoting GitHub's words names nobody.
    expect(
      refusedUser(
        errorMessages(
          '[{"body":"we saw: API rate limit exceeded for user ID 5"}]',
        ),
      ),
    ).toBeNull();
    expect(
      refusedUser(
        errorMessages(
          '{"data":{"issue":{"body":"API rate limit exceeded for user ID 5"}}}',
        ),
      ),
    ).toBeNull();
  });
});
