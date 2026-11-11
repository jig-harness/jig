import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import {
  jiraAuthorization,
  resolveJiraCredential,
  SHARED_COMMANDS_MAX,
  type TokenRun,
  type TokenRunner,
} from "../scripts/lib/tracker/jira/credential.ts";
import {
  parseJiraSettings,
  requestBase,
} from "../scripts/lib/tracker/jira/settings.ts";
import {
  defaultTransport,
  httpTransport,
  type JiraApiError,
} from "../scripts/lib/tracker/jira/transport.ts";
import { GATEWAY, SITE, tokenRun } from "./jira-fixtures.ts";

const fieldOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TrackerConfigError
      ? e.field
      : `not a config error: ${String(e)}`;
  }
};

describe("issue_tracker.jira.api_base", () => {
  it("sends requests to the gateway, and keeps the site for links", () => {
    const s = parseJiraSettings({ site: SITE, api_base: `${GATEWAY}/` });
    expect([s.site, s.apiBase, requestBase(s)]).toEqual([
      SITE,
      GATEWAY,
      GATEWAY,
    ]);
    expect(requestBase(parseJiraSettings({ site: SITE }))).toBe(SITE);
    expect(fieldOf(() => requestBase(parseJiraSettings({})))).toBe(
      "issue_tracker.jira.site",
    );
    expect(
      fieldOf(() =>
        parseJiraSettings({
          site: "https://attacker.example",
          api_base: GATEWAY,
        }),
      ),
    ).toBe("issue_tracker.jira.site");
  });

  it("refuses any other host or path shape", () => {
    const id = "11223344-a1b2-c3d4-e5f6-001122334455";
    for (const api_base of [
      `http://api.atlassian.com/ex/jira/${id}`,
      `https://api.atlassian.com:443/ex/jira/${id}`,
      `https://user@api.atlassian.com/ex/jira/${id}`,
      `https://api.atlassian.com.example.com/ex/jira/${id}`,
      `https://evil.example/ex/jira/${id}`,
      `${SITE}/ex/jira/${id}`,
      `https://api.atlassian.com/ex/confluence/${id}`,
      `https://api.atlassian.com/ex/jira/${id}/rest`,
      `https://api.atlassian.com/ex/jira/${id}//`,
      `https://api.atlassian.com/ex/jira/${id}?x=1`,
      `https://api.atlassian.com/ex/jira/${id}#x`,
      `https://api.atlassian.com/ex/jira/${id}\n`,
      `https://api.atlassian.com/ex/jira/../${id}`,
      "https://api.atlassian.com/ex/jira/",
      "https://api.atlassian.com/ex/jira/-x",
      ` https://api.atlassian.com/ex/jira/${id}`,
      "",
      3,
    ])
      expect([
        api_base,
        fieldOf(() => parseJiraSettings({ site: SITE, api_base })),
      ]).toEqual([api_base, "issue_tracker.jira.api_base"]);
  });

  it("opens the adapter on the gateway, and keeps the site for links", () => {
    const index = join(import.meta.dir, "../scripts/lib/tracker/index.ts");
    const config = join(import.meta.dir, "../scripts/lib/tracker/config.ts");
    const script = `
      const { openTracker } = await import(${JSON.stringify(index)});
      const { parseTrackerConfig } = await import(${JSON.stringify(config)});
      const seen = [];
      globalThis.fetch = async (url, init) => {
        seen.push([String(url), init.headers.Authorization]);
        return new Response("{}", { status: 200 });
      };
      const t = openTracker(parseTrackerConfig({ issue_tracker: { adapter: "jira", team: "ENG",
        jira: { site: ${JSON.stringify(SITE)}, api_base: ${JSON.stringify(GATEWAY)} } } }), ".");
      await t.reach();
      console.log(JSON.stringify(seen));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], {
      env: { PATH: process.env.PATH ?? "", JIRA_BEARER_TOKEN: "oauth-token" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, "the adapter opened on api_base");
    const seen = JSON.parse(r.stdout.toString().trim()) as [string, string][];
    expect(seen.length).toBeGreaterThan(0);
    for (const [url, authorization] of seen) {
      expect(url.startsWith(`${GATEWAY}/rest/api/3/`)).toBe(true);
      expect(authorization).toBe("Bearer oauth-token");
    }
  });

  it("is not widened by JIRA_ALLOWED_HOSTS", () => {
    const settings = join(
      import.meta.dir,
      "../scripts/lib/tracker/jira/settings.ts",
    );
    const script = `
      const { parseJiraSettings } = await import(${JSON.stringify(settings)});
      const site = parseJiraSettings({ site: "https://jira.example.com" }).site;
      try {
        parseJiraSettings({ site, api_base: "https://jira.example.com/ex/jira/abc" });
        console.log("accepted");
      } catch (e) {
        console.log("refused " + e.field);
      }`;
    const r = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, JIRA_ALLOWED_HOSTS: "jira.example.com" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, "settings under JIRA_ALLOWED_HOSTS");
    expect(r.stdout.toString().trim()).toBe(
      "refused issue_tracker.jira.api_base",
    );
  });
});

describe("Jira credential", () => {
  const basic = { JIRA_EMAIL: "a@example.com", JIRA_API_TOKEN: "t" };

  it("takes a Bearer token first, then the token command, then the Basic pair", () => {
    expect(
      resolveJiraCredential({
        ...basic,
        JIRA_TOKEN_COMMAND: "broker token",
        JIRA_BEARER_TOKEN: " b ",
      }),
    ).toEqual({ ok: true, value: { kind: "bearer", token: "b" } });
    expect(
      resolveJiraCredential({
        ...basic,
        JIRA_BEARER_TOKEN: "  ",
        JIRA_TOKEN_COMMAND: `broker "jira token"`,
      }),
    ).toEqual({
      ok: true,
      value: { kind: "command", argv: ["broker", "jira token"] },
    });
    expect(
      resolveJiraCredential({ ...basic, JIRA_TOKEN_COMMAND: " " }),
    ).toEqual({
      ok: true,
      value: { kind: "basic", email: "a@example.com", token: "t" },
    });
  });

  it("refuses a Bearer token with a space or a line break, naming the variable", () => {
    for (const bad of ["a b", "a\nb", "a\u0000b"]) {
      const r = resolveJiraCredential({ JIRA_BEARER_TOKEN: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.reason).toContain("JIRA_BEARER_TOKEN");
        expect(r.failure.reason).not.toContain(bad);
      }
    }
  });

  it("refuses a token command it cannot read, without repeating it", () => {
    const r = resolveJiraCredential({
      JIRA_TOKEN_COMMAND: `broker --secret "s3cret`,
    });
    expect(r).toEqual({
      ok: false,
      failure: {
        code: "token-command",
        reason: 'JIRA_TOKEN_COMMAND cannot be read as a command: unclosed "',
      },
    });
  });

  it("signs with the Bearer token over the Basic pair", async () => {
    const r = resolveJiraCredential({ ...basic, JIRA_BEARER_TOKEN: "b" });
    if (!r.ok) throw new Error(r.failure.reason);
    expect(await jiraAuthorization(r.value).header()).toEqual({
      ok: true,
      value: "Bearer b",
    });
  });
});

/** The `Authorization` header a request carried, `""` when none. */
const authorizationOf = (init: RequestInit | undefined): string =>
  (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";

/** A fetch that answers each request with the next status, recording the headers sent. */
function statuses(...codes: number[]) {
  const sent: string[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    sent.push(authorizationOf(init));
    const status = codes[Math.min(sent.length - 1, codes.length - 1)] ?? 200;
    return new Response(status === 200 ? '{"ok":true}' : "", { status });
  }) as typeof fetch;
  return { sent, impl };
}

/** A runner that prints each of `tokens` in turn, counting its runs. */
function printing(...tokens: string[]) {
  const runs: string[][] = [];
  const runner: TokenRunner = async (argv) => {
    runs.push(argv);
    return tokenRun(`${tokens[runs.length - 1] ?? "spent"}\n`);
  };
  return { runs, runner };
}

const command = (runner: TokenRunner, timeoutMs?: number) =>
  jiraAuthorization(
    { kind: "command", argv: ["/opt/broker/bin/broker", "jira"] },
    { runner, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );

const request = { method: "GET", path: "myself" } as const;

const failure = async (p: Promise<unknown>) =>
  (await p.then(
    () => new Error("resolved"),
    (e: unknown) => e,
  )) as JiraApiError;

describe("JIRA_TOKEN_COMMAND", () => {
  it("runs once for every request of the process", async () => {
    const { runs, runner } = printing("one");
    const { sent, impl } = statuses(200);
    const t = httpTransport(GATEWAY, command(runner), impl);
    await t(request);
    await t(request);
    await Promise.all([t(request), t(request)]);
    expect(runs).toEqual([["/opt/broker/bin/broker", "jira"]]);
    expect(sent).toEqual(Array(4).fill("Bearer one"));
  });

  it("runs once more after a 401 and sends the request again with the new token", async () => {
    const { runs, runner } = printing("old", "new");
    const { sent, impl } = statuses(401, 200);
    const t = httpTransport(GATEWAY, command(runner), impl);
    expect(await t(request)).toEqual({ ok: true });
    expect([runs.length, sent]).toEqual([2, ["Bearer old", "Bearer new"]]);
    await t(request);
    expect([runs.length, sent.at(-1)]).toEqual([2, "Bearer new"]);
  });

  it("fails a request refused again after the renewal, without a third try", async () => {
    const { runs, runner } = printing("old", "new");
    const { sent, impl } = statuses(401);
    const err = await failure(
      httpTransport(GATEWAY, command(runner), impl)(request),
    );
    expect([err.status, err.unavailable]).toEqual([401, true]);
    expect([runs.length, sent]).toEqual([2, ["Bearer old", "Bearer new"]]);
  });

  it("shares one renewal among the requests a token was refused for", async () => {
    const { runs, runner } = printing("old", "new");
    const sent: string[] = [];
    const gate = Promise.withResolvers<void>();
    const impl = (async (_url: unknown, init?: RequestInit) => {
      const auth = authorizationOf(init);
      sent.push(auth);
      if (auth === "Bearer old") {
        await gate.promise;
        return new Response("", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = httpTransport(GATEWAY, command(runner), impl);
    const all = Promise.all([t(request), t(request), t(request)]);
    const deadline = Date.now() + 5_000;
    while (sent.length < 3 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    gate.resolve();
    await all;
    expect(runs.length).toBe(2);
    expect(sent.filter((h) => h === "Bearer new")).toHaveLength(3);
  });

  it("does not renew a Basic pair or a Bearer token after a 401", async () => {
    for (const auth of [
      jiraAuthorization({ kind: "bearer", token: "b" }),
      jiraAuthorization({ kind: "basic", email: "a@example.com", token: "t" }),
    ]) {
      const { sent, impl } = statuses(401, 200);
      const err = await failure(httpTransport(SITE, auth, impl)(request));
      expect([err.status, sent.length]).toEqual([401, 1]);
    }
  });

  it("names the variable when the command fails, never what it printed", async () => {
    const cases: [Partial<TokenRun> & { stdout?: string }, string][] = [
      [
        { code: 3, stdout: "s3cret", stderr: "warming up\nnot signed in\n" },
        "JIRA_TOKEN_COMMAND (broker) exited 3: not signed in",
      ],
      [{ stdout: "  \n" }, "JIRA_TOKEN_COMMAND (broker) printed no token"],
      [
        { stdout: "s3cret\nmore" },
        "JIRA_TOKEN_COMMAND (broker) printed more than a token; it must print the token alone",
      ],
      [
        { timedOut: true, code: 124, stdout: "s3cret" },
        "JIRA_TOKEN_COMMAND (broker) printed no token within 30 seconds",
      ],
      [
        { spawnFailed: true, code: 127 },
        "JIRA_TOKEN_COMMAND (broker) could not start",
      ],
    ];
    for (const [over, message] of cases) {
      const runner: TokenRunner = async () => tokenRun(over.stdout ?? "", over);
      const { sent, impl } = statuses(200);
      const err = await failure(
        httpTransport(GATEWAY, command(runner), impl)(request),
      );
      expect([err.message, err.unavailable, sent]).toEqual([message, true, []]);
      expect(err.message).not.toContain("s3cret");
    }
    const thrown = await failure(
      httpTransport(
        GATEWAY,
        command(async () => {
          throw new Error("spawn refused");
        }),
        statuses(200).impl,
      )(request),
    );
    expect(thrown.message).toBe(
      "JIRA_TOKEN_COMMAND could not be run: spawn refused",
    );
  });

  it("runs again for the next request after a failed run", async () => {
    let n = 0;
    const runner: TokenRunner = async () =>
      ++n === 1 ? tokenRun("", { code: 1 }) : tokenRun("later\n");
    const { sent, impl } = statuses(200);
    const t = httpTransport(GATEWAY, command(runner), impl);
    await failure(t(request));
    await t(request);
    expect([n, sent]).toEqual([2, ["Bearer later"]]);
  });

  it("stops waiting for a token when the request is cancelled", async () => {
    // The run finishes only when the test says so, after the request ended.
    const late = Promise.withResolvers<TokenRun>();
    const runner: TokenRunner = () => late.promise;
    let alive: ReturnType<typeof setTimeout> | undefined;
    const { sent, impl } = statuses(200);
    const stop = new AbortController();
    const pending = httpTransport(
      GATEWAY,
      command(runner),
      impl,
    )(request, stop.signal).then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    stop.abort(new Error("deadline"));
    try {
      const ended = await Promise.race([
        pending,
        new Promise<string>((r) => {
          alive = setTimeout(() => r("still waiting"), 2_000);
        }),
      ]);
      expect(ended).toBe("Jira request cancelled: deadline");
      expect(sent).toEqual([]);
    } finally {
      late.resolve(tokenRun("late\n"));
      clearTimeout(alive);
    }
  });

  it("names the token command when the call's deadline ends the wait", async () => {
    const late = Promise.withResolvers<TokenRun>();
    const auth = command(() => late.promise);
    try {
      const r = await auth.header(AbortSignal.timeout(50));
      expect(r.ok ? r.value : r.failure.reason).toMatch(
        /^JIRA_TOKEN_COMMAND \(.+\) printed no token before the request's deadline$/,
      );
    } finally {
      late.resolve(tokenRun("late\n"));
    }
  });

  it("starts no renewal run for a request that has already ended", async () => {
    let runs = 0;
    const auth = command(async () => {
      runs++;
      return tokenRun("t\n");
    });
    const lease = await auth.lease();
    const stop = new AbortController();
    stop.abort(new Error("gone"));
    const renewed = await lease.renew(stop.signal);
    expect(renewed !== null && !renewed.ok).toBe(true);
    expect(runs).toBe(1);
  });

  it("runs a real command, and stops one that overruns its deadline", async () => {
    const real = jiraAuthorization({
      kind: "command",
      argv: [process.execPath, "-e", "console.log('real-token')"],
    });
    expect(await real.header()).toEqual({
      ok: true,
      value: "Bearer real-token",
    });
    const slow = jiraAuthorization(
      {
        kind: "command",
        argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      },
      { timeoutMs: 500 },
    );
    const r = await slow.header();
    expect(r.ok ? r.value : r.failure.reason).toMatch(
      /^JIRA_TOKEN_COMMAND \(.+\) printed no token within 0\.5 seconds$/,
    );
  });

  it("runs a real command once for every tracker the process opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jira-token-"));
    try {
      const counter = join(dir, "runs");
      const argv = [
        process.execPath,
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); console.log('shared-token')`,
      ];
      const first = jiraAuthorization({ kind: "command", argv });
      const second = jiraAuthorization({ kind: "command", argv });
      const wanted = { ok: true as const, value: "Bearer shared-token" };
      expect(await first.header()).toEqual(wanted);
      expect(await second.header()).toEqual(wanted);
      expect(readFileSync(counter, "utf8")).toBe("x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Waits, polling to a deadline, until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 5));
}

/** A fetch whose first two requests wait for a gate each, then answer 401; later ones answer 200. */
function staggered() {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const signals: (AbortSignal | null | undefined)[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const n = signals.push(init?.signal) - 1;
    const gate = gates[n];
    if (gate === undefined) return new Response("{}", { status: 200 });
    await gate.promise;
    return new Response("", { status: 401 });
  }) as typeof fetch;
  return { gates, signals, impl };
}

describe("JIRA_TOKEN_COMMAND renewal by generation", () => {
  it("renews once for staggered 401s even when the broker prints the same token", async () => {
    const runs: string[][] = [];
    const runner: TokenRunner = async (argv) => {
      runs.push(argv);
      return tokenRun("same\n");
    };
    const { gates, signals, impl } = staggered();
    const t = httpTransport(GATEWAY, command(runner), impl);
    const both = Promise.all([t(request), t(request)]);
    await until(() => signals.length === 2);
    gates[0]?.resolve();
    await until(() => signals.length === 3);
    gates[1]?.resolve();
    await both;
    expect([runs.length, signals.length]).toEqual([2, 4]);
  });

  it("keeps a failed renewal as the answer of the requests that waited for it", async () => {
    const runs: string[][] = [];
    const runner: TokenRunner = async (argv) => {
      runs.push(argv);
      return runs.length === 1
        ? tokenRun("first\n")
        : tokenRun("", { code: 1 });
    };
    const { gates, signals, impl } = staggered();
    const t = httpTransport(GATEWAY, command(runner), impl);
    const both = Promise.all([failure(t(request)), failure(t(request))]);
    await until(() => signals.length === 2);
    gates[0]?.resolve();
    await until(() => runs.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    gates[1]?.resolve();
    const errors = await both;
    expect(runs.length).toBe(2);
    expect(errors.map((e) => e.message)).toEqual([
      "JIRA_TOKEN_COMMAND (broker) exited 1",
      "JIRA_TOKEN_COMMAND (broker) exited 1",
    ]);
  });

  it("spends one deadline on a call and its second attempt", async () => {
    const { runner } = printing("old", "new");
    const signals: (AbortSignal | null | undefined)[] = [];
    const impl = (async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response("{}", { status: signals.length === 1 ? 401 : 200 });
    }) as typeof fetch;
    await httpTransport(GATEWAY, command(runner), impl)(request);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
  });
});

describe("JIRA_TOKEN_COMMAND process state", () => {
  it("runs from the home directory, not the working directory", async () => {
    const auth = jiraAuthorization({
      kind: "command",
      argv: [
        process.execPath,
        "-e",
        `const fs = require('node:fs'); console.log(fs.realpathSync(process.cwd()) === ${JSON.stringify(realpathSync(homedir()))} ? 'home' : 'other:' + process.cwd().replace(/\\s/g, '_'))`,
      ],
    });
    expect(await auth.header()).toEqual({ ok: true, value: "Bearer home" });
  });

  it("shares a bounded number of commands", () => {
    const of = (i: number) =>
      jiraAuthorization({ kind: "command", argv: ["bounded-broker", `${i}`] });
    const first = of(0);
    expect(of(0)).toBe(first);
    for (let i = 1; i <= SHARED_COMMANDS_MAX; i++) of(i);
    expect(of(0)).not.toBe(first);
  });
});

describe("a Bearer credential at an Atlassian Cloud site", () => {
  const sent = () => {
    const urls: string[] = [];
    const impl = (async (url: unknown) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return { urls, impl };
  };

  it.each([
    ["JIRA_BEARER_TOKEN", { JIRA_BEARER_TOKEN: "oauth-token" }],
    ["JIRA_TOKEN_COMMAND", { JIRA_TOKEN_COMMAND: "broker token" }],
  ])(
    "is refused before a request without api_base (%s)",
    async (variable, env) => {
      const { urls, impl } = sent();
      const err = await failure(defaultTransport(SITE, env, impl)(request));
      expect(err.message).toContain(variable);
      expect(err.message).toContain("issue_tracker.jira.api_base");
      expect(err.message).not.toContain("HTTP 403");
      expect(urls).toEqual([]);
    },
  );

  it("is sent through the gateway", async () => {
    const { urls, impl } = sent();
    await defaultTransport(
      GATEWAY,
      { JIRA_BEARER_TOKEN: "oauth-token" },
      impl,
    )(request);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.startsWith(`${GATEWAY}/`)).toBe(true);
  });

  it("leaves Basic authentication at the site alone", async () => {
    const { urls, impl } = sent();
    await defaultTransport(
      SITE,
      { JIRA_EMAIL: "a@example.com", JIRA_API_TOKEN: "t" },
      impl,
    )(request);
    expect(urls).toHaveLength(1);
  });

  it("leaves an allowed self-hosted site alone, and names the variable on its first 403", async () => {
    const env = {
      JIRA_BEARER_TOKEN: "pat",
      JIRA_ALLOWED_HOSTS: "jira.example.com",
    };
    const refused = await failure(
      defaultTransport(
        "https://jira.example.com",
        env,
        statuses(403).impl,
      )(request),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toContain("HTTP 403");
    expect(refused.message).toContain("JIRA_BEARER_TOKEN");
    // Once the site has answered, a later 403 is the request's own.
    const transport = defaultTransport(
      "https://jira.example.com",
      env,
      statuses(200, 403).impl,
    );
    await transport(request);
    const later = await failure(transport(request));
    expect(later.status).toBe(403);
    expect(later.message).not.toContain("JIRA_BEARER_TOKEN");
  });
});
