import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  causeChain,
  type DetachedFailure,
  type DetachedOptions,
  reportDetachedFailure,
  runDetached,
  safeString,
} from "./detached.ts";

/** Let the started chain settle: its rejection handler runs on a later tick. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A hand-written thenable whose `then` is `then`. */
const thenable = (then: () => unknown): unknown =>
  new Proxy({}, { get: (_, key) => (key === "then" ? then : undefined) });

/** A reporter that records what it was given, and a fallback that does too. */
function recorder() {
  const reports: DetachedFailure[] = [];
  const lines: string[] = [];
  return {
    reports,
    lines,
    report: (f: DetachedFailure) => {
      reports.push(f);
    },
    fallback: (line: string) => {
      lines.push(line);
    },
  };
}

describe("runDetached", () => {
  test("a rejection is reported with its cause chain and never escapes", async () => {
    const r = recorder();
    const root = new Error("root");
    const boom = new Error("boom", {
      cause: new Error("middle", { cause: root }),
    });
    runDetached(Promise.reject(boom), { label: "sync index", ...r });
    await settle();
    expect(r.reports).toHaveLength(1);
    const [f] = r.reports;
    expect(f?.label).toBe("sync index");
    expect(f?.error).toBe(boom);
    expect(f?.errorName).toBe("Error");
    expect(f?.message).toBe("boom");
    expect(f?.causes).toEqual(["middle", "root"]);
    expect(f?.defect).toBe(false);
    expect(f?.stack).toContain("boom");
    expect(r.lines).toEqual([]);
  });

  test("a thunk that throws before returning a promise is reported too", async () => {
    const r = recorder();
    runDetached(
      () => {
        throw new TypeError("early");
      },
      { label: "warm cache", ...r, context: { job: 7 } },
    );
    await settle();
    expect(r.reports.map((f) => [f.errorName, f.message, f.context])).toEqual([
      ["TypeError", "early", { job: 7 }],
    ]);
  });

  test("a reason that is not an error is described, not thrown on", async () => {
    const r = recorder();
    const unprintable = Object.create(null) as object;
    runDetached(Promise.reject("plain text"), { label: "a", ...r });
    runDetached(Promise.reject(unprintable), { label: "b", ...r });
    await settle();
    expect(r.reports.map((f) => [f.errorName, f.message, f.causes])).toEqual([
      ["string", "plain text", []],
      ["object", "[unprintable object]", []],
    ]);
  });

  test("the repository's own defect type is classed by isDefect", async () => {
    class Defect extends Error {}
    const r = recorder();
    runDetached(Promise.reject(new Defect("invariant broken")), {
      label: "a",
      ...r,
      isDefect: (e) => e instanceof Defect,
    });
    await settle();
    expect(r.reports[0]?.defect).toBe(true);
  });

  test("a successful chain reports nothing", async () => {
    const r = recorder();
    runDetached(async () => "done", { label: "a", ...r });
    await settle();
    expect(r.reports).toEqual([]);
    expect(r.lines).toEqual([]);
  });
});

describe("reportDetachedFailure", () => {
  test("a reporter that throws falls back to one line without the error's text", () => {
    const r = recorder();
    reportDetachedFailure(new Error("secret=hunter2"), {
      label: "rotate keys",
      report: () => {
        throw new Error("logger down");
      },
      fallback: r.fallback,
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("rotate keys");
    expect(r.lines[0]).toContain("defect=false");
    expect(r.lines[0]).not.toContain("hunter2");
    expect(r.lines[0]).not.toContain("logger down");
  });

  test("an isDefect that throws classes the reason as a failure, and the report goes through", () => {
    const r = recorder();
    reportDetachedFailure(new Error("x"), {
      label: "a",
      ...r,
      isDefect: () => {
        throw new Error("revoked proxy");
      },
    });
    expect(r.reports.map((f) => [f.message, f.defect])).toEqual([["x", false]]);
    expect(r.lines).toEqual([]);
  });

  test("a fallback that throws leaves nothing to report to, and nothing escapes", () => {
    expect(() =>
      reportDetachedFailure(new Error("x"), {
        label: "a",
        report: () => {
          throw new Error("logger down");
        },
        fallback: () => {
          throw new Error("stderr closed");
        },
      }),
    ).not.toThrow();
  });
});

/**
 * True only when an async function does not type-check as `C`: the compile
 * time half of refusing one. `refused` below fails to compile otherwise.
 */
type RefusesAsync<C> = ((...args: unknown[]) => Promise<void>) extends C
  ? false
  : true;
const refused: [
  RefusesAsync<DetachedOptions["report"]>,
  RefusesAsync<NonNullable<DetachedOptions["fallback"]>>,
] = [true, true];

/** An async callback forced past the type check, as untyped code could. */
const untyped = <C>(callback: () => Promise<void>) => callback as unknown as C;

describe("a reporter or fallback that returns a promise", () => {
  test("the types refuse an async reporter or fallback", () => {
    expect(refused).toEqual([true, true]);
  });

  test("an async reporter that rejects falls back, and no rejection is left behind", async () => {
    const r = recorder();
    reportDetachedFailure(new Error("secret=hunter2"), {
      label: "send mail",
      report: untyped<DetachedOptions["report"]>(async () => {
        throw new Error("logger down");
      }),
      fallback: r.fallback,
    });
    await settle();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("send mail");
    expect(r.lines[0]).not.toContain("hunter2");
  });

  test("an async fallback that rejects is settled too, and nothing escapes", async () => {
    const r = recorder();
    let fallbackCalls = 0;
    expect(() =>
      reportDetachedFailure(new Error("x"), {
        label: "a",
        report: untyped<DetachedOptions["report"]>(async () => {
          throw new Error("logger down");
        }),
        fallback: untyped<NonNullable<DetachedOptions["fallback"]>>(
          async () => {
            fallbackCalls++;
            throw new Error("sink closed");
          },
        ),
      }),
    ).not.toThrow();
    await settle();
    await settle();
    expect(fallbackCalls).toBe(1);
    expect(r.lines).toEqual([]);
  });

  test("a returned value whose then rejects asynchronously falls back once, and nothing escapes", async () => {
    const r = recorder();
    const escaped: unknown[] = [];
    const listener = (reason: unknown) => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      expect(() =>
        reportDetachedFailure(new Error("x"), {
          label: "a",
          // A hand-written thenable whose `then` rejects through the promise
          // it returns rather than through its callbacks.
          report: (() =>
            new Proxy(
              {},
              {
                get: (_, key) =>
                  key === "then"
                    ? async () => {
                        throw new Error("logger down");
                      }
                    : undefined,
              },
            )) as unknown as DetachedOptions["report"],
          fallback: r.fallback,
        }),
      ).not.toThrow();
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(escaped).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("could not be reported");
  });

  test("a rejected promise at the end of a long chain of hand-written thenables is handled", async () => {
    const r = recorder();
    const escaped: unknown[] = [];
    const listener = (reason: unknown) => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      // Eight wrappers, each whose `then` returns the next, ending in a
      // native promise that rejects.
      let chain: unknown = Promise.reject(new Error("logger down"));
      for (let i = 0; i < 8; i++) {
        const next = chain;
        chain = thenable(() => next);
      }
      reportDetachedFailure(new Error("x"), {
        label: "a",
        report: (() => chain) as unknown as DetachedOptions["report"],
        fallback: r.fallback,
      });
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(escaped).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("could not be reported");
  });

  test("a chain of hand-written thenables longer than the bound falls back", () => {
    const r = recorder();
    // A `then` that returns a fresh thenable forever never settles.
    const endless = (): unknown => thenable(() => endless());
    reportDetachedFailure(new Error("x"), {
      label: "a",
      report: endless as unknown as DetachedOptions["report"],
      fallback: r.fallback,
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("could not be reported");
  });

  test("a returned value whose then getter throws falls back, like a rejection", () => {
    const r = recorder();
    const unreadable = new Proxy(
      {},
      {
        get(): never {
          throw new Error("then getter");
        },
      },
    );
    expect(() =>
      reportDetachedFailure(new Error("x"), {
        label: "a",
        report: (() => unreadable) as unknown as DetachedOptions["report"],
        fallback: r.fallback,
      }),
    ).not.toThrow();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("could not be reported");
  });
});

describe("a reason whose fields cannot be read", () => {
  test("a revoked proxy is described and passed to the reporter as it is", () => {
    const r = recorder();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    reportDetachedFailure(proxy, { label: "a", ...r });
    expect(r.lines).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]?.error).toBe(proxy);
    expect(r.reports[0]?.message).toBe("[unprintable object]");
  });

  test("an error with throwing getters is described field by field", () => {
    class Hostile extends Error {
      override get name(): string {
        throw new Error("name getter");
      }
      override get message(): string {
        throw new Error("message getter");
      }
      override get cause(): unknown {
        throw new Error("cause getter");
      }
    }
    const r = recorder();
    const hostile = new Hostile();
    // The stack is an own property of each error, so its getter goes there.
    Object.defineProperty(hostile, "stack", {
      get() {
        throw new Error("stack getter");
      },
    });
    reportDetachedFailure(hostile, { label: "a", ...r });
    expect(r.lines).toEqual([]);
    const [f] = r.reports;
    expect(f?.error).toBe(hostile);
    expect(f?.errorName).toBe("[unreadable name]");
    expect(f?.message).toBe("[unreadable message]");
    expect(f?.causes).toEqual([]);
    expect(f?.stack).toBeUndefined();
  });
});

describe("causeChain and safeString", () => {
  test("a cause cycle and a long chain are bounded", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(causeChain(b)).toEqual(["a"]);
    let deep: Error = new Error("0");
    for (let i = 1; i < 20; i++) deep = new Error(String(i), { cause: deep });
    expect(causeChain(deep)).toHaveLength(10);
  });

  test("a non-error cause is printed, and a value that cannot be is named", () => {
    expect(causeChain(new Error("x", { cause: "disk full" }))).toEqual([
      "disk full",
    ]);
    expect(safeString(Object.create(null))).toBe("[unprintable object]");
    expect(safeString(Symbol("s"))).toBe("Symbol(s)");
  });
});

describe("installUnhandledRejectionListener", () => {
  // The listener changes the whole process's behaviour, so it is tried in a
  // child process, never in this one. Each child lets the rejection surface
  // by yielding one macrotask, then prints a last line.
  const scratch = mkdtempSync(join(tmpdir(), "detached-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const helper = pathToFileURL(join(import.meta.dir, "detached.ts")).href;

  function child(name: string, body: string) {
    const script = join(scratch, `${name}.ts`);
    writeFileSync(
      script,
      `import { installUnhandledRejectionListener } from ${JSON.stringify(helper)};\n${body}\n`,
    );
    const r = Bun.spawnSync([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ...r, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test("without the listener the runtime reports the rejection and the process fails", () => {
    const r = child(
      "bare",
      `Promise.reject(new Error("boom"));\nawait new Promise((d) => setImmediate(d));\nconsole.log("still running");`,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toContain("boom");
  });

  test("with it the rejection is reported with its cause and the process goes on", () => {
    const r = child(
      "installed",
      `installUnhandledRejectionListener({ report: (f) => console.log(JSON.stringify({ label: f.label, message: f.message, causes: f.causes, defect: f.defect })) });
Promise.reject(new Error("boom", { cause: new Error("root") }));
await new Promise((d) => setImmediate(d));
console.log("still running");`,
    );
    expectSpawnExit(r, 0, "installed listener");
    expect(r.out).toContain(
      '{"label":"unhandled rejection","message":"boom","causes":["root"],"defect":false}',
    );
    expect(r.out).toContain("still running");
  });

  test("a reporter that throws reaches standard error, and the process goes on", () => {
    const r = child(
      "fallback",
      `installUnhandledRejectionListener({ label: "worker", report: () => { throw new Error("logger down"); } });
Promise.reject(new Error("secret=hunter2"));
await new Promise((d) => setImmediate(d));
console.log("still running");`,
    );
    expectSpawnExit(r, 0, "throwing reporter");
    expect(r.err).toContain("worker: a detached failure could not be reported");
    expect(r.err).not.toContain("hunter2");
    expect(r.out).toContain("still running");
  });

  test("the disposer removes the listener, and the process fails again", () => {
    const r = child(
      "disposed",
      `const dispose = installUnhandledRejectionListener({ report: () => console.log("reported") });
dispose();
Promise.reject(new Error("boom"));
await new Promise((d) => setImmediate(d));
console.log("still running");`,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.out).not.toContain("reported");
    expect(r.err).toContain("boom");
  });
});
