import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BudgetRecord,
  budgetGovernor,
  sqliteBudgetStore,
} from "../outbound/budget.ts";
import {
  activeUserIn,
  githubCredential,
  installationOwner,
  legacyGithubCredential,
  unverifiedOwner,
  userOwner,
} from "../outbound/github-credential.ts";
import {
  type DiscoverUser,
  DISCOVERY_BACKOFF_MS,
  githubOwnerResolver,
  mergedRecord,
  sqliteOwnerStore,
  userOf,
} from "../outbound/github-owner.ts";
import { githubBalances, setForgeGovernor } from "../outbound/github-budget.ts";
import { ghRunFailure } from "../outbound/github.ts";
import type { OutboundFailure } from "../outbound/failure.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";
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

const directories: string[] = [];
const databases: string[] = [];

afterEach(() => {
  setForgeGovernor(null);
  for (const path of databases.splice(0)) closeDatabase(path);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-forge-owner-"));
  directories.push(dir);
  return dir;
}

function databasePath(): string {
  const path = join(scratch(), "budget.sqlite");
  databases.push(path);
  return path;
}

/** A discovery that answers from `users` by token, or by the stored login's account; counting its calls. */
function discovery(users: Record<string, number>, account = () => "") {
  const asked: Env[] = [];
  const discover: DiscoverUser = async (env) => {
    asked.push(env);
    const name = env.GH_TOKEN ?? env.GH_ENTERPRISE_TOKEN ?? account();
    const id = users[name];
    return id === undefined
      ? {
          failure: {
            code: "unauthorized",
            reason: "gh exited 1: HTTP 401",
          },
        }
      : { user: { id, login: `user${id}` } };
  };
  return { discover, asked };
}

/** One process's view of the machine's budget database at `path`. */
function processOn(
  path: string,
  discover: DiscoverUser,
  clock: () => number = currentMs,
) {
  const store = sqliteBudgetStore(path);
  const governor = budgetGovernor(store, { share: () => null, clock });
  const owners = githubOwnerResolver({
    owners: sqliteOwnerStore(path),
    budget: store,
    governor,
    discover,
    clock,
  });
  return { store, governor, owners };
}

/** A forge client sending with `env`, whose `gh` is `answer`. */
function client(env: Env, answer: (argv: string[]) => Run = () => ok("{}")) {
  const sent: string[][] = [];
  const runner = traceGhRunner<Run, { env?: Env; timeoutSec?: number }>(
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
  return { run: (args: string[]) => runner(args, { env }), sent };
}

const ok = (stdout: string): Run => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

/** An answer whose headers say `remaining` of the core window are left. */
const core = (remaining: number) =>
  ok(
    `HTTP/2.0 200 OK\nx-ratelimit-resource: core\nx-ratelimit-limit: 5000\nx-ratelimit-remaining: ${remaining}\nx-ratelimit-reset: ${Math.floor((currentMs() + 3_600_000) / 1000)}\n\n{}`,
  );

const held = (until: number): BudgetRecord => ({
  requests: { limit: 5000, remaining: 4000, resetAt: until + 1000 },
  complexity: { limit: null, remaining: null, resetAt: null },
  limitedUntil: until,
  why: "GitHub refused the credential",
  observedAt: 1,
  strikes: 2,
});

describe("personal tokens of one user share one quota record", () => {
  it("lets another process's token for the same user see exhaustion and send nothing", async () => {
    const path = databasePath();
    const users = { "token-a": 7, "token-b": 7, "token-c": 8 };
    const first = processOn(path, discovery(users).discover);
    setForgeGovernor(first.governor, first.owners);
    await client({ GH_TOKEN: "token-a" }, () => core(0)).run([
      "api",
      "repos/o/r",
    ]);

    const second = processOn(path, discovery(users).discover);
    setForgeGovernor(second.governor, second.owners);
    const other = client({ GH_TOKEN: "token-b" });
    const refused = await other.run(["api", "repos/o/r/pulls"]);
    expect(other.sent).toHaveLength(0);
    expect(ghRunFailure(refused)?.code).toBe("rate-limited");

    // Another user's allowance is its own.
    const stranger = client({ GH_TOKEN: "token-c" });
    expect((await stranger.run(["api", "repos/o/r/pulls"])).code).toBe(0);
    expect(stranger.sent).toHaveLength(1);
  });

  it("reserves both tokens' requests from one balance", async () => {
    const path = databasePath();
    const users = { "token-a": 7, "token-b": 7 };
    const first = processOn(path, discovery(users).discover);
    const second = processOn(path, discovery(users).discover);
    setForgeGovernor(first.governor, first.owners);
    const a = client({ GH_TOKEN: "token-a" }, () => ok("{}"));
    await client({ GH_TOKEN: "token-a" }, () => core(2)).run([
      "api",
      "repos/o/r",
    ]);
    setForgeGovernor(second.governor, second.owners);
    const b = client({ GH_TOKEN: "token-b" });
    await b.run(["api", "repos/o/r/issues"]);
    setForgeGovernor(first.governor, first.owners);
    await a.run(["api", "repos/o/r/pulls"]);
    setForgeGovernor(second.governor, second.owners);
    const last = await b.run(["api", "repos/o/r/labels"]);
    expect(b.sent).toHaveLength(1);
    expect(a.sent).toHaveLength(1);
    expect(ghRunFailure(last)?.code).toBe("rate-limited");
    expect(
      second.store.read(userOwner("github.com", 7))?.requests.remaining,
    ).toBe(0);
  });
});

describe("the stored login and an environment token", () => {
  function configDir(user: string): string {
    const dir = scratch();
    writeFileSync(
      join(dir, "hosts.yml"),
      `github.com:\n    users:\n        ${user}:\n            oauth_token: x\n    git_protocol: https\n    user: ${user}\n`,
    );
    return dir;
  }

  it("reads the active account of the host's block in hosts.yml", () => {
    const text =
      "ghe.example.com:\n  user: other\ngithub.com:\n  users:\n    alice:\n      user: nested\n  user: alice # active\n";
    expect(activeUserIn(text, "github.com")).toBe("alice");
    expect(activeUserIn(text, "ghe.example.com")).toBe("other");
    expect(activeUserIn(text, "nowhere.example")).toBeNull();
    expect(activeUserIn("github.com:\n  users: {}\n", "github.com")).toBeNull();
  });

  it("converge on one verified owner", async () => {
    const dir = configDir("alice");
    const { discover, asked } = discovery(
      { "alice-token": 11, alice: 11 },
      () => "alice",
    );
    const machine = processOn(databasePath(), discover);
    const stored = await machine.owners.resolve({ GH_CONFIG_DIR: dir });
    const token = await machine.owners.resolve({ GH_TOKEN: "alice-token" });
    expect(stored.credential).not.toBe(token.credential);
    expect(stored.owner).toBe(token.owner);
    expect(stored).toMatchObject({ verified: true, login: "user11" });
    expect(asked).toHaveLength(2);
  });

  it("does not inherit the previous account's owner after an account switch", async () => {
    const dir = configDir("alice");
    let account = "alice";
    const { discover, asked } = discovery(
      { alice: 11, bob: 12 },
      () => account,
    );
    const machine = processOn(databasePath(), discover);
    const before = await machine.owners.resolve({ GH_CONFIG_DIR: dir });
    writeFileSync(
      join(dir, "hosts.yml"),
      "github.com:\n    user: bob\n    oauth_token: y\n",
    );
    account = "bob";
    const after = await machine.owners.resolve({ GH_CONFIG_DIR: dir });
    expect(after.credential).not.toBe(before.credential);
    expect(after.owner).toBe(userOwner("github.com", 12));
    expect(before.owner).toBe(userOwner("github.com", 11));
    expect(asked).toHaveLength(2);
  });

  it("keeps one user id on another host apart", async () => {
    const { discover } = discovery({ one: 5 });
    const machine = processOn(databasePath(), discover);
    const cloud = await machine.owners.resolve({ GH_TOKEN: "one" });
    const server = await machine.owners.resolve({
      GH_HOST: "GHE.example.com",
      GH_ENTERPRISE_TOKEN: "one",
    });
    expect(cloud.owner).not.toBe(server.owner);
    expect(server.owner).toBe(userOwner("ghe.example.com", 5));
  });

  it("keeps a credential whose owner is unknown under the host's shared unverified record, and asks again only after the backoff", async () => {
    const path = databasePath();
    let now = 1_000_000_000;
    const { discover, asked } = discovery({});
    const machine = processOn(path, discover, () => now);
    const one = await machine.owners.resolve({ GH_TOKEN: "unknown-1" });
    const two = await machine.owners.resolve({ GH_TOKEN: "unknown-2" });
    expect(one).toMatchObject({
      owner: unverifiedOwner("github.com"),
      verified: false,
    });
    expect(two.owner).toBe(one.owner);
    expect(asked).toHaveLength(2);

    // Another process reads the backoff the first one kept.
    const later = processOn(path, discover, () => now);
    await later.owners.resolve({ GH_TOKEN: "unknown-1" });
    expect(asked).toHaveLength(2);
    now += DISCOVERY_BACKOFF_MS + 1;
    await later.owners.resolve({ GH_TOKEN: "unknown-1" });
    expect(asked).toHaveLength(3);
  });

  it("holds every unverified credential on the host when one of them is refused", async () => {
    const path = databasePath();
    const machine = processOn(path, discovery({}).discover);
    setForgeGovernor(machine.governor, machine.owners);
    await client({ GH_TOKEN: "unknown-1" }, () => ({
      code: 1,
      stdout:
        'HTTP/2.0 403 Forbidden\nRetry-After: 120\n\n{"message":"You have exceeded a secondary rate limit"}',
      stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)\n",
      timedOut: false,
    })).run(["api", "repos/o/r"]);
    const other = client({ GH_TOKEN: "unknown-2" });
    const refused = await other.run(["pr", "view", "1"]);
    expect(other.sent).toHaveLength(0);
    expect(ghRunFailure(refused)?.code).toBe("rate-limited");
    // A credential on another host is not held by it.
    const elsewhere = client({
      GH_HOST: "ghe.example.com",
      GH_ENTERPRISE_TOKEN: "unknown-3",
    });
    await elsewhere.run(["pr", "view", "1"]);
    expect(elsewhere.sent).toHaveLength(1);
  });
});

describe("installation tokens", () => {
  it("share one record per declared installation, across a replacement token, and keep its hold", async () => {
    const path = databasePath();
    const { discover, asked } = discovery({});
    const machine = processOn(path, discover);
    setForgeGovernor(machine.governor, machine.owners);
    const declared = { JIG_GITHUB_INSTALLATION_ID: "42" };
    await client({ GH_TOKEN: "ghs_first", ...declared }, () => ({
      code: 1,
      stdout:
        'HTTP/2.0 403 Forbidden\nRetry-After: 120\n\n{"message":"You have exceeded a secondary rate limit"}',
      stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)\n",
      timedOut: false,
    })).run(["api", "repos/o/r"]);
    const replacement = client({ GH_TOKEN: "ghs_second", ...declared });
    await replacement.run(["api", "repos/o/r"]);
    expect(replacement.sent).toHaveLength(0);
    expect(
      machine.store.read(installationOwner("github.com", 42))?.limitedUntil,
    ).toBeGreaterThan(currentMs());

    const other = client({
      GH_TOKEN: "ghs_third",
      JIG_GITHUB_INSTALLATION_ID: "43",
    });
    await other.run(["api", "repos/o/r"]);
    expect(other.sent).toHaveLength(1);
    expect(asked).toHaveLength(0);
  });

  it("gives an installation token with no valid declaration the unverified record, never one of its own", async () => {
    const machine = processOn(databasePath(), discovery({}).discover);
    for (const declared of [undefined, "0", "x1", "-3"]) {
      const found = await machine.owners.resolve({
        GH_TOKEN: "ghs_undeclared",
        JIG_GITHUB_INSTALLATION_ID: declared,
      });
      expect(found).toMatchObject({
        owner: unverifiedOwner("github.com"),
        verified: false,
      });
    }
  });
});

describe("discovery is bounded and reused", () => {
  it("asks once for many runs, at once or one after another, and not again in another process", async () => {
    const path = databasePath();
    const users = { "token-a": 3 };
    const first = discovery(users);
    const machine = processOn(path, first.discover);
    setForgeGovernor(machine.governor, machine.owners);
    const forge = client({ GH_TOKEN: "token-a" });
    const events: CallRecord[] = [];
    await withLedgerWriter(
      (e) => events.push(e),
      async () => {
        await Promise.all([
          forge.run(["pr", "view", "1"]),
          forge.run(["api", "repos/o/r"]),
          forge.run(["issue", "list"]),
        ]);
        for (let i = 0; i < 3; i += 1) await forge.run(["pr", "list"]);
      },
    );
    expect(first.asked).toHaveLength(1);
    const lookup = events.filter((e) => e.operation === "GET /user");
    expect(lookup).toHaveLength(1);
    expect(lookup[0]).toMatchObject({
      requests: 1,
      estimated: true,
      owner: userOwner("github.com", 3),
    });
    expect(
      events
        .filter((e) => e.operation !== "GET /user")
        .every((e) => e.owner === userOwner("github.com", 3)),
    ).toBe(true);

    const again = discovery(users);
    const next = processOn(path, again.discover);
    setForgeGovernor(next.governor, next.owners);
    await client({ GH_TOKEN: "token-a" }).run(["pr", "view", "2"]);
    expect(again.asked).toHaveLength(0);
  });

  it("asks nothing for local commands or for GET /user itself", async () => {
    const { discover, asked } = discovery({ "token-a": 3 });
    const machine = processOn(databasePath(), discover);
    setForgeGovernor(machine.governor, machine.owners);
    const forge = client({ GH_TOKEN: "token-a" });
    await forge.run(["auth", "status"]);
    await forge.run(["api", "user", "--jq", ".login"]);
    expect(asked).toHaveLength(0);
    expect(forge.sent).toHaveLength(2);
  });

  it("asks nothing while the unverified record is held", async () => {
    const path = databasePath();
    const { discover, asked } = discovery({ "token-a": 3 });
    const machine = processOn(path, discover);
    machine.store.update(unverifiedOwner("github.com"), () =>
      held(currentMs() + 60_000),
    );
    const found = await machine.owners.resolve({ GH_TOKEN: "token-a" });
    expect(asked).toHaveLength(0);
    expect(found.owner).toBe(unverifiedOwner("github.com"));
  });

  it("names only a user an answer to GET /user names", () => {
    expect(userOf('{"id": 9, "login": "octo"}')).toEqual({
      id: 9,
      login: "octo",
    });
    expect(userOf('{"id": "9", "login": "octo"}')).toBeNull();
    expect(userOf('{"id": 0, "login": "octo"}')).toBeNull();
    expect(userOf("not json")).toBeNull();
  });
});

describe("records an earlier release kept", () => {
  it("seed the owner's record, keeping an active hold, and stay readable", async () => {
    const path = databasePath();
    const env = { GH_TOKEN: "token-a" };
    const machine = processOn(path, discovery({ "token-a": 3 }).discover);
    const until = currentMs() + 600_000;
    machine.store.update(legacyGithubCredential(env), () => held(until));
    const found = await machine.owners.resolve(env);
    expect(machine.store.read(found.owner)).toMatchObject({
      limitedUntil: until,
      strikes: 2,
    });
    expect(machine.store.read(legacyGithubCredential(env))?.limitedUntil).toBe(
      until,
    );
  });

  it("carry the stored login's opaque record into its owner's", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "hosts.yml"), "github.com:\n  user: alice\n");
    const env = { GH_CONFIG_DIR: dir };
    expect(githubCredential(env)).not.toBe(legacyGithubCredential(env));
    const machine = processOn(
      databasePath(),
      discovery({ alice: 11 }, () => "alice").discover,
    );
    const until = currentMs() + 600_000;
    machine.store.update(legacyGithubCredential(env), () => held(until));
    machine.store.update(userOwner("github.com", 11), () => ({
      ...held(0),
      limitedUntil: null,
      strikes: 0,
    }));
    await machine.owners.resolve(env);
    expect(machine.store.read(userOwner("github.com", 11))?.limitedUntil).toBe(
      until,
    );
  });

  it("merge conservatively: the later hold, more refusals, the lower balance of one reset, else the later reset", () => {
    const now = 1_000;
    const base: BudgetRecord = {
      requests: { limit: 5000, remaining: 100, resetAt: 9_000 },
      complexity: { limit: 5000, remaining: 10, resetAt: 5_000 },
      limitedUntil: 2_000,
      why: "first",
      observedAt: 1,
      strikes: 1,
    };
    const other: BudgetRecord = {
      requests: { limit: 5000, remaining: 50, resetAt: 9_000 },
      complexity: { limit: 5000, remaining: 4000, resetAt: 8_000 },
      limitedUntil: 3_000,
      why: "second",
      observedAt: 2,
      strikes: 3,
    };
    expect(mergedRecord(base, other, now)).toMatchObject({
      requests: { remaining: 50 },
      complexity: { remaining: 4000, resetAt: 8_000 },
      limitedUntil: 3_000,
      why: "second",
      strikes: 3,
    });
  });

  it("let the budget reading find the owner's record from the known mapping", async () => {
    const machine = processOn(
      databasePath(),
      discovery({ "token-a": 3 }).discover,
    );
    const env = { GH_TOKEN: "token-a" };
    const found = await machine.owners.resolve(env);
    machine.store.update(found.owner, () => ({
      ...held(0),
      limitedUntil: null,
      observedAt: 77,
    }));
    const read = (key: string) => machine.store.read(key);
    const owner = (e: Env) => machine.owners.known(e)?.owner ?? null;
    expect(githubBalances(env, read, owner)?.observedAt).toBe(77);
    expect(machine.owners.known({ GH_TOKEN: "never-asked" })).toBeNull();
  });
});
