/**
 * The lifecycle verbs over stand-in components: which components each verb
 * reaches, in what order, and what `run` hands the command line. The verbs
 * that write files (`install`, `uninstall`) run end to end in
 * `plugin/__tests__/lifecycle.test.ts`, in a child with a scratch home.
 */
import { expect, spyOn, test } from "bun:test";
import { gcComponent } from "../../gc/component.ts";
import { gcJobSpec } from "../../gc/job-spec.ts";
import type { Component } from "../component.ts";
import { runVerb, type VerbArguments } from "../verbs.ts";

/** A component that records what the verbs ask of it. */
function standIn(
  name: string,
  calls: string[],
  options: { missingOptIn?: string; exit?: number } = {},
): Component {
  return {
    name,
    command: gcComponent.command as unknown as Component["command"],
    main: async () => 0,
    job: () => ({
      ...gcJobSpec(),
      name: `jig-${name}`,
      args: [name, "--timer"],
    }),
    missingOptIn: () => options.missingOptIn ?? null,
    install: async () => {
      calls.push(`install ${name}`);
      return options.exit ?? 0;
    },
    uninstall: async () => {
      calls.push(`uninstall ${name}`);
      return options.exit ?? 0;
    },
    status: async () => {
      calls.push(`status ${name}`);
      return {
        component: name,
        installed: false,
        detail: "no job installed",
        schedule: null,
        nextRun: null,
        lastRun: null,
      };
    },
    receipts: (query) => {
      calls.push(`receipts ${name} ${query}`);
      return 0;
    },
  };
}

/** Runs `args` over `components`, recording each command line `run` starts. */
async function verb(
  args: VerbArguments,
  components: Component[],
  platform?: NodeJS.Platform,
) {
  const started: string[][] = [];
  const quiet = [spyOn(console, "log"), spyOn(console, "error")];
  // The verbs' report is not what these tests check; it stays off the test output.
  for (const spy of quiet) spy.mockImplementation(() => undefined);
  try {
    const code = await runVerb(args, {
      components,
      script: "/installed/jig.ts",
      ...(platform === undefined ? {} : { platform }),
      run: async (argv) => {
        started.push([...argv]);
        return 0;
      },
    });
    const said = quiet.flatMap((spy) =>
      spy.mock.calls.map((call) => String(call[0])),
    );
    return { code, started, said };
  } finally {
    for (const spy of quiet) spy.mockRestore();
  }
}

test("run gc starts exactly the command line collection's timer runs", async () => {
  const { code, started } = await verb({ verb: "run", components: ["gc"] }, [
    gcComponent,
  ]);
  expect(code).toBe(0);
  expect(started).toEqual([gcJobSpec().args]);
});

test("run with no component named leaves out one whose opt-in is missing, and says why", async () => {
  const calls: string[] = [];
  const { started, said } = await verb({ verb: "run", components: [] }, [
    standIn("first", calls),
    standIn("second", calls, { missingOptIn: "no machine file" }),
    standIn("third", calls),
  ]);
  expect(started).toEqual([
    ["first", "--timer"],
    ["third", "--timer"],
  ]);
  expect(said).toContain("second: skipped: no machine file");
});

test("a component named runs whatever its opt-in, so its own command can refuse", async () => {
  const calls: string[] = [];
  const { started } = await verb({ verb: "run", components: ["second"] }, [
    standIn("first", calls),
    standIn("second", calls, { missingOptIn: "no machine file" }),
  ]);
  expect(started).toEqual([["second", "--timer"]]);
});

test("a verb over several components stops at the first that fails, with its exit code", async () => {
  const calls: string[] = [];
  const { code } = await verb(
    {
      verb: "uninstall",
      components: ["first", "second"],
      repository: undefined,
      machine: false,
      confirm: false,
    },
    [standIn("first", calls, { exit: 2 }), standIn("second", calls)],
  );
  expect(code).toBe(2);
  expect(calls).toEqual(["uninstall first"]);
});

test("status and receipts reach the components named, in registration order", async () => {
  const calls: string[] = [];
  const components = [standIn("first", calls), standIn("second", calls)];
  await verb(
    { verb: "status", components: ["second", "first"], json: true },
    components,
  );
  await verb(
    { verb: "receipts", component: "second", query: "2026-10-31" },
    components,
  );
  expect(calls).toEqual([
    "status first",
    "status second",
    "receipts second 2026-10-31",
  ]);
});

test("uninstall on Windows leaves out every component's job, which no scheduler holds there", async () => {
  const calls: string[] = [];
  const { code, said } = await verb(
    {
      verb: "uninstall",
      components: [],
      repository: undefined,
      machine: true,
      confirm: false,
    } as VerbArguments,
    [standIn("gc", calls), standIn("dispatch", calls)],
    "win32",
  );
  expect(code).toBe(0);
  expect(calls).toEqual([]);
  expect(said.join("\n")).toContain("== the jig command ==");
});
