/**
 * The agent-harness interface's contract (ADR-0026): every registered
 * harness, and a third one registered only here, answers each operation in
 * the shape its callers rely on; the registry finds each by what callers
 * hold; and Claude Code's and Codex's commands are the ones the dispatcher
 * and the drive have always run.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "../agent-harness/claude-code.ts";
import { CODEX_BYPASS, codex } from "../agent-harness/codex.ts";
import {
  type AgentHarness,
  credentialVariables,
  defaultHarness,
  directoryVariables,
  harnessFor,
  harnessNamed,
  harnessOfProgram,
  harnessOfRuntime,
  harnesses,
  isHarnessName,
  isSessionMarker,
  registerHarness,
} from "../agent-harness/index.ts";
import { Defect } from "../outcome.ts";
import { FAKE_NAME, fakeHarness } from "./fake-harness.ts";

const unregister: Array<() => void> = [];
afterEach(() => {
  for (const undo of unregister.splice(0)) undo();
});

/** The harness under contract, registered for the test when it is not already. */
function registered(harness: AgentHarness): AgentHarness {
  if (harnessNamed(harness.name) === null)
    unregister.push(registerHarness(harness));
  return harness;
}

const UNDER_CONTRACT: readonly AgentHarness[] = [...harnesses(), fakeHarness];

describe("every harness keeps the interface's contract", () => {
  for (const candidate of UNDER_CONTRACT) {
    describe(candidate.name, () => {
      it("identifies itself by the names callers find it by", () => {
        const harness = registered(candidate);
        expect(harness.identify()).toMatchObject({
          name: harness.name,
          label: harness.label,
          program: harness.program,
          runtime: harness.runtime,
        });
        expect(harnessNamed(harness.name)).toBe(harness);
        expect(harnessFor(harness.name)).toBe(harness);
        expect(isHarnessName(harness.name)).toBe(true);
        expect(harnessOfRuntime(harness.runtime)).toBe(harness);
        expect(harnessOfProgram(`/opt/bin/${harness.program}`)).toBe(harness);
        expect(harnessOfProgram(`${harness.program}.exe`)).toBe(harness);
      });

      it("builds a pass that starts its program and ends on the prompt", () => {
        const harness = registered(candidate);
        const bare = harness.passCommand({ prompt: "do the round" });
        expect(harnessOfProgram(bare[0])).toBe(harness);
        expect(bare.at(-1)).toBe("do the round");
        const routed = harness.passCommand({
          prompt: "do the round",
          model: "m-1",
          effort: "high",
          hostArgs: ["--extra"],
          sessionId: "00000000-0000-4000-8000-000000000000",
        });
        expect(routed.at(-1)).toBe("do the round");
        expect(routed.join(" ")).toContain(harness.model("m-1").join(" "));
        expect(routed.join(" ")).toContain(harness.effort("high").join(" "));
        expect(routed).toContain("--extra");
        const interactive = harness.interactiveCommand({
          prompt: "pick it up",
          model: "m-1",
        });
        expect(harnessOfProgram(interactive[0])).toBe(harness);
        expect(interactive.at(-1)).toBe("pick it up");
        expect(interactive.join(" ")).toContain(harness.model("m-1").join(" "));
        const resume = harness.resumeCommand("s-1");
        expect(harnessOfProgram(resume[0])).toBe(harness);
        expect(resume).toContain("s-1");
      });

      it("carries a skill's invocation in its prompt", () => {
        const harness = registered(candidate);
        expect(harness.skillPrompt("/jig:steward")).toContain("/jig:steward");
      });

      it("names its model once, where its own words take it", () => {
        const harness = registered(candidate);
        const argv = harness.withModel(
          harness.passCommand({ prompt: "p" }),
          "m-2",
          null,
        );
        const words = harness.model("m-2");
        expect(argv.at(-1)).toBe("p");
        const starts = argv.filter((_, i) =>
          words.every((w, j) => argv[i + j] === w),
        );
        expect(starts.length).toBe(1);
        expect(harness.modelFlags).toContain(words[0] as string);
      });

      it("says what a launch carries and removes", () => {
        const harness = registered(candidate);
        const { environment } = harness;
        expect(environment.directoryVariable).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(directoryVariables()).toContain(environment.directoryVariable);
        for (const name of environment.credentialVariables) {
          expect(credentialVariables()).toContain(name);
          expect(environment.isSessionMarker(name)).toBe(false);
        }
        for (const name of Object.keys(environment.sessionMarkers("/acct"))) {
          expect(environment.isSessionMarker(name)).toBe(true);
          expect(isSessionMarker(name)).toBe(true);
        }
      });

      it("reads no account from a directory that holds no login", () => {
        const harness = registered(candidate);
        const empty = mkdtempSync(join(tmpdir(), "jig-harness-contract-"));
        try {
          const identity = harness.accountIdentity({
            HOME: empty,
            [harness.environment.directoryVariable]: empty,
          });
          expect(identity.vendor).toBe(harness.name);
          if (identity.account === null)
            expect(identity.reason).toEqual(expect.any(String));
          else expect(identity.reason).toBeNull();
          expect(identity.provenance).not.toBe("");
        } finally {
          rmSync(empty, { recursive: true, force: true });
        }
      });

      it("finds no session or transcript where there is none", () => {
        const harness = registered(candidate);
        expect(harness.sessionIdIn("")).toBeNull();
        if (harness.capabilities.sessionId === "minted")
          expect(
            harness.sessionIdIn(
              "session id: 01234567-89ab-cdef-0123-456789abcdef",
            ),
          ).toBeNull();
        const walked: string[] = [];
        expect(
          harness.transcript({
            configDir: "/nowhere",
            session: "01234567-89ab-cdef-0123-456789abcdef",
            startedMs: 0,
            walk: (dir) => {
              walked.push(dir);
              return true;
            },
          }),
        ).toBeNull();
      });

      it("answers an operation it does not supply as not supplied", () => {
        const harness = registered(candidate);
        const usage = harness.usage("");
        const stop = harness.classifyStop(1, "");
        if (!harness.capabilities.usage)
          expect(usage).toMatchObject({
            ok: false,
            failure: { code: "not-supplied" },
          });
        if (!harness.capabilities.classifyStop)
          expect(stop).toMatchObject({
            ok: false,
            failure: { code: "not-supplied" },
          });
      });
    });
  }
});

describe("the registry", () => {
  it("lists Claude Code first, then Codex, each name, program and runtime once", () => {
    expect(harnesses().slice(0, 2)).toEqual([claudeCode, codex]);
    expect(defaultHarness()).toBe(claudeCode);
    for (const key of ["name", "program", "runtime"] as const) {
      const values = harnesses().map((h) => h[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("adds a harness until its registration is undone, and refuses a second of one name", () => {
    expect(isHarnessName(FAKE_NAME)).toBe(false);
    const undo = registerHarness(fakeHarness);
    try {
      expect(harnesses().at(-1)).toBe(fakeHarness);
      expect(() => registerHarness(fakeHarness)).toThrow(Defect);
    } finally {
      undo();
    }
    expect(harnessNamed(FAKE_NAME)).toBeNull();
    expect(() => harnessFor(FAKE_NAME)).toThrow(Defect);
  });

  it("finds nothing for a program, runtime or name no harness has", () => {
    expect(harnessOfProgram("my-wrapper.sh")).toBeNull();
    expect(harnessOfProgram("")).toBeNull();
    expect(harnessOfProgram(undefined)).toBeNull();
    expect(harnessOfRuntime(null)).toBeNull();
    expect(isHarnessName(7)).toBe(false);
  });
});

describe("Claude Code's and Codex's commands", () => {
  it("are the documented pass commands", () => {
    expect(
      claudeCode.passCommand({
        prompt: "p",
        sessionId: "s",
        model: "opus",
        effort: "high",
        hostArgs: ["--permission-mode", "auto"],
      }),
    ).toEqual([
      "claude",
      "--session-id",
      "s",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "auto",
      "-p",
      "p",
    ]);
    expect(
      codex.passCommand({
        prompt: "p",
        sessionId: "s",
        model: "gpt-x",
        effort: "high",
        bypass: true,
        hostArgs: ["--dangerously-bypass-hook-trust"],
      }),
    ).toEqual([
      "codex",
      "exec",
      CODEX_BYPASS,
      "--dangerously-bypass-hook-trust",
      "-m",
      "gpt-x",
      "-c",
      'model_reasoning_effort="high"',
      "p",
    ]);
    expect(claudeCode.passCommand({ prompt: "p", bypass: true })).toEqual([
      "claude",
      "-p",
      "p",
    ]);
  });

  it("run a skill as each takes it, and resume a session", () => {
    expect(claudeCode.skillPrompt("/jig:do-item 7")).toBe("/jig:do-item 7");
    expect(codex.skillPrompt("/jig:do-item 7")).toBe(
      "Use the jig:do-item skill: /jig:do-item 7",
    );
    expect(claudeCode.resumeCommand("s")).toEqual(["claude", "--resume", "s"]);
    expect(codex.resumeCommand("s")).toEqual(["codex", "resume", "s"]);
  });

  it("place a model where each takes it", () => {
    expect(claudeCode.withModel(["claude", "-p", "x"], "opus", null)).toEqual([
      "claude",
      "--model",
      "opus",
      "-p",
      "x",
    ]);
    expect(codex.withModel(["codex", "exec", "x"], "gpt-x", 3)).toEqual([
      "codex",
      "exec",
      "-m",
      "gpt-x",
      "x",
    ]);
  });

  it("read Codex's printed session id, which Claude Code never prints", () => {
    const id = "01234567-89AB-cdef-0123-456789abcdef";
    expect(codex.sessionIdIn(`header\nsession id: ${id}\n`)).toBe(
      id.toLowerCase(),
    );
    expect(
      codex.sessionIdIn(`{"type":"thread.started","thread_id":"${id}"}`),
    ).toBe(id.toLowerCase());
    expect(claudeCode.sessionIdIn(`session id: ${id}`)).toBeNull();
  });
});
