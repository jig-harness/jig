/**
 * Every transport reports a failed call as one of the closed failure
 * classes (`shared/outbound/failure.ts`), and each class takes its policy:
 * a read is sent once more only after `unreachable` or `server-fault`, the
 * reader keeps its last reading (reports "try later") only for a class that
 * clears by waiting, and `tracker.ts` exits with the class's own code. A
 * fake of each transport (Linear, GitHub over HTTPS and through `gh`, Jira,
 * and the forge client's `gh` runs) produces every class.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  clearsByWaiting,
  FAILURE_CLASSES,
  type FailureClass,
  POLICIES,
  retriedOnce,
  TIMEOUT_FLOOR_MS,
} from "../../../shared/outbound/failure.ts";
import { ghRunFailure } from "../../../shared/outbound/github.ts";
import { TrackerRateLimited } from "../../../shared/tracker-budget.ts";
import {
  ghTransport,
  httpTransport as githubHttp,
} from "../scripts/lib/tracker/github/transport.ts";
import { jiraAuthorization } from "../scripts/lib/tracker/jira/credential.ts";
import { httpTransport as jiraHttp } from "../scripts/lib/tracker/jira/transport.ts";
import { httpTransport as linearHttp } from "../scripts/lib/tracker/linear-transport.ts";
import { isUnavailable } from "../scripts/lib/tracker/unavailable.ts";
import { EXIT_OF_CLASS, failureExit } from "../scripts/tracker.ts";
import type { RunResult } from "../../drive-pr/scripts/lib/proc.ts";

afterEach(() => {
  setSystemTime();
});

/** An answer a fake fetch gives: a status and a body, or a throw for no answer. */
type Fake = { status: number; body: unknown; headers?: Record<string, string> };

/** What a fake HTTPS system answers for each class: no answer, or one that took past the timeout floor. */
type Answers = Record<FailureClass, Fake | "no answer" | "out of time">;

/** A fetch that answers `answer` to every request, counting them. */
function fetcher(answer: Answers[FailureClass]) {
  let sent = 0;
  const impl = (async () => {
    sent++;
    if (answer === "no answer") throw new TypeError("fetch failed");
    if (answer === "out of time") {
      // The system worked on the request until it gave up.
      setSystemTime(new Date(Date.now() + TIMEOUT_FLOOR_MS + 1_000));
      return new Response("<html>Gateway Timeout</html>", { status: 504 });
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Retry-After": "0", ...answer.headers },
    });
  }) as unknown as typeof fetch;
  return { impl, sent: () => sent };
}

/** The error a call threw. */
async function thrown(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("the call did not fail");
}

/** Each class's policy, as one failed read shows it. */
function takesPolicy(error: unknown, code: FailureClass, sent: number): void {
  expect(error).toMatchObject({ code });
  expect(sent).toBe(retriedOnce(code) ? 2 : 1);
  expect(isUnavailable(error)).toBe(clearsByWaiting(code));
  expect(failureExit(error).code).toBe(EXIT_OF_CLASS[code]);
}

const LINEAR: Answers = {
  "rate-limited": {
    status: 400,
    body: { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] },
  },
  unreachable: "no answer",
  "too-costly": "out of time",
  "server-fault": { status: 503, body: {} },
  unauthorized: {
    status: 401,
    body: {
      errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }],
    },
  },
  "not-found": {
    status: 200,
    body: { errors: [{ message: "Entity not found: Issue" }] },
  },
  invalid: {
    status: 400,
    body: { errors: [{ message: "x", extensions: { code: "INVALID_INPUT" } }] },
  },
};

const GITHUB: Answers = {
  "rate-limited": {
    status: 403,
    body: { message: "API rate limit exceeded" },
    headers: { "x-ratelimit-remaining": "0" },
  },
  unreachable: "no answer",
  "too-costly": {
    status: 200,
    body: { errors: [{ type: "MAX_NODE_LIMIT_EXCEEDED", message: "x" }] },
  },
  "server-fault": { status: 503, body: {} },
  unauthorized: { status: 401, body: { message: "Bad credentials" } },
  "not-found": {
    status: 200,
    body: { data: { repository: null }, errors: [{ type: "NOT_FOUND" }] },
  },
  invalid: {
    status: 200,
    body: { errors: [{ type: "argumentLiteralsIncompatible", message: "x" }] },
  },
};

const JIRA: Answers = {
  "rate-limited": { status: 429, body: {} },
  unreachable: "no answer",
  "too-costly": "out of time",
  "server-fault": { status: 503, body: {} },
  unauthorized: { status: 401, body: {} },
  "not-found": {
    status: 404,
    body: { errorMessages: ["Issue does not exist"] },
  },
  invalid: { status: 400, body: { errorMessages: ["The JQL is wrong"] } },
};

describe("the Linear transport", () => {
  for (const code of FAILURE_CLASSES)
    it(`fails a query as ${code} and takes its policy`, async () => {
      const f = fetcher(LINEAR[code]);
      const error = await thrown(
        linearHttp("lin_test", f.impl)("query Q { viewer { id } }", {}),
      );
      takesPolicy(error, code, f.sent());
    });
});

describe("the GitHub tracker transport over HTTPS", () => {
  for (const code of FAILURE_CLASSES)
    it(`fails a read as ${code} and takes its policy`, async () => {
      const f = fetcher(GITHUB[code]);
      const error = await thrown(
        githubHttp("https://github.example/graphql", "test", f.impl)(
          "query { viewer { login } }",
          {},
          undefined,
          true,
        ),
      );
      takesPolicy(error, code, f.sent());
    });
});

/** What a fake `gh api graphql --include` run prints for each class. */
const GH: Record<FailureClass, Partial<RunResult>> = {
  "rate-limited": {
    code: 1,
    stdout:
      'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 4102444800\r\n\r\n{"message":"API rate limit exceeded"}',
  },
  unreachable: {
    code: 1,
    stderr: "dial tcp: lookup api.github.com: no such host",
  },
  "too-costly": { code: 124, timedOut: true },
  "server-fault": {
    code: 1,
    stdout: "HTTP/2.0 503 Service Unavailable\r\n\r\n{}",
  },
  unauthorized: {
    code: 1,
    stdout: 'HTTP/2.0 401 Unauthorized\r\n\r\n{"message":"Bad credentials"}',
  },
  "not-found": {
    code: 1,
    stdout:
      'HTTP/2.0 200 OK\r\n\r\n{"data":{"repository":null},"errors":[{"type":"NOT_FOUND"}]}',
  },
  invalid: {
    code: 1,
    stdout:
      'HTTP/2.0 200 OK\r\n\r\n{"errors":[{"type":"argumentLiteralsIncompatible"}]}',
  },
};

describe("the GitHub tracker transport through gh", () => {
  for (const code of FAILURE_CLASSES)
    it(`fails a read as ${code} and takes its policy`, async () => {
      let sent = 0;
      const transport = ghTransport(async () => {
        sent++;
        return {
          code: 0,
          stdout: "",
          stderr: "",
          stderrTail: "",
          timedOut: false,
          bufferExceeded: false,
          spawnFailed: false,
          ...GH[code],
        };
      });
      const error = await thrown(
        transport("query { viewer { login } }", {}, undefined, true),
      );
      takesPolicy(error, code, sent);
    });
});

describe("the Jira transport", () => {
  for (const code of FAILURE_CLASSES)
    it(`fails a GET as ${code} and takes its policy`, async () => {
      const f = fetcher(JIRA[code]);
      const error = await thrown(
        jiraHttp(
          "https://jira.example",
          jiraAuthorization({ kind: "bearer", token: "test" }),
          f.impl,
        )({ method: "GET", path: "myself" }),
      );
      takesPolicy(error, code, f.sent());
    });
});

/** What a failed run of the forge client's `gh` says for each class, and how long it took. */
const FORGE: Record<
  FailureClass,
  { stderr: string; tookMs?: number; timedOut?: boolean }
> = {
  "rate-limited": {
    stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
  },
  unreachable: { stderr: "dial tcp: lookup api.github.com: no such host" },
  "too-costly": { stderr: "gh: HTTP 504", tookMs: 11_000 },
  "server-fault": { stderr: "gh: HTTP 502", tookMs: 300 },
  unauthorized: { stderr: "gh: Bad credentials (HTTP 401)" },
  "not-found": { stderr: "gh: Not Found (HTTP 404)" },
  invalid: { stderr: "gh: Validation Failed (HTTP 422)" },
};

describe("the forge client's gh runs", () => {
  for (const code of FAILURE_CLASSES)
    it(`classifies a run that met ${code}`, () => {
      const { stderr, tookMs, timedOut } = FORGE[code];
      const failure = ghRunFailure(
        { code: 1, stderr, timedOut: timedOut ?? false },
        tookMs,
      );
      expect(failure?.code).toBe(code);
      if (code === "rate-limited") expect(failure?.until).toBeNumber();
    });

  it("reads a run past its deadline as the forge running out of time, and a success as no failure", () => {
    expect(ghRunFailure({ code: 124, stderr: "", timedOut: true })?.code).toBe(
      "too-costly",
    );
    expect(ghRunFailure({ code: 0, stderr: "", timedOut: false })).toBeNull();
  });
});

describe("each class's policy", () => {
  it("tells a person at once only of a refused credential, and never of a wait or an absence", () => {
    const told = Object.fromEntries(
      FAILURE_CLASSES.map((c) => [c, POLICIES[c].told]),
    );
    expect(told).toEqual({
      "rate-limited": "never",
      unreachable: "after-count",
      "too-costly": "smallest-request",
      "server-fault": "after-count",
      unauthorized: "at-once",
      "not-found": "never",
      invalid: "after-count",
    });
  });

  it("gives tracker.ts one exit per class, keeping 5 for a rate limit and the RATE-LIMITED line", () => {
    expect(new Set(Object.values(EXIT_OF_CLASS)).size).toBe(
      FAILURE_CLASSES.length,
    );
    for (const used of [0, 1, 2, 3, 4])
      expect(Object.values(EXIT_OF_CLASS)).not.toContain(used);
    const limited = failureExit(
      new TrackerRateLimited("linear", Date.parse("2026-11-13T12:00:00Z"), "x"),
    );
    expect(limited.code).toBe(5);
    expect(limited.line).toStartWith(
      "RATE-LIMITED until 2026-11-13T12:00:00.000Z:",
    );
    expect(failureExit(new Error("boom")).code).toBe(1);
  });
});
