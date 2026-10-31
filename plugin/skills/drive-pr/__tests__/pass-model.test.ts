/**
 * drive-pr suite: the model a drive's passes run on (`lib/pass-model.ts`):
 * `--pass-model` over the pass command's own `--model` over the configured
 * one, a routing tier resolved through the tier-to-model table, and a pass
 * command that is not Claude Code's left to choose its own.
 */

import { describe, expect, it } from "bun:test";
import {
  diagLines,
  formatClaim,
  parseClaimText,
} from "../scripts/lib/claim.ts";
import {
  effectivePass,
  type PassModel,
  PassModelUsageError,
  resolveModelValue,
  withoutModel,
} from "../scripts/lib/pass-model.ts";

const PASS = ["claude", "-p", "/jig:drive-pr --bots-only 7"];
const SONNET: PassModel = { model: "sonnet", source: "the default" };
const configured = () => SONNET;
const noRouting = () => ({});

describe("resolveModelValue", () => {
  it("takes a model id or an alias as written", () => {
    expect(resolveModelValue("sonnet", "--pass-model", noRouting)).toEqual({
      model: "sonnet",
      source: "--pass-model",
    });
    expect(
      resolveModelValue("claude-sonnet-4-5", "drive.pass_model", noRouting)
        .model,
    ).toBe("claude-sonnet-4-5");
  });

  it("resolves a tier through the default tier-to-model table", () => {
    expect(
      resolveModelValue("execution", "drive.pass_model", noRouting),
    ).toEqual({
      model: "sonnet",
      source:
        "drive.pass_model: the execution tier, routing.models.claude-code.execution",
    });
    expect(
      resolveModelValue("strategic", "--pass-model", noRouting).model,
    ).toBe("opus");
  });

  it("resolves a tier through the repository's own table", () => {
    const routing = () => ({
      routing: {
        models: { "claude-code": { execution: "haiku", strategic: "opus" } },
      },
    });
    expect(resolveModelValue("execution", "--pass-model", routing).model).toBe(
      "haiku",
    );
  });

  it("refuses a value that is not one word", () => {
    expect(() =>
      resolveModelValue("--model sonnet", "--pass-model", noRouting),
    ).toThrow(PassModelUsageError);
    expect(() => resolveModelValue("", "--pass-model", noRouting)).toThrow(
      PassModelUsageError,
    );
  });
});

describe("effectivePass", () => {
  it("adds the configured model after claude when nothing names one", () => {
    expect(effectivePass(PASS, undefined, configured)).toEqual({
      argv: ["claude", "--model", "sonnet", ...PASS.slice(1)],
      model: "sonnet",
      source: "the default",
    });
  });

  it("keeps the pass command's own --model, in either spelling, whatever the setting says", () => {
    const unread = () => {
      throw new Error("the setting cannot be read");
    };
    const own = ["claude", "--model", "opus", ...PASS.slice(1)];
    expect(effectivePass(own, undefined, unread)).toEqual({
      argv: own,
      model: "opus",
      source: "the pass command's own --model",
    });
    const inline = ["claude", "--model=haiku", ...PASS.slice(1)];
    expect(effectivePass(inline, undefined, unread).model).toBe("haiku");
    expect(effectivePass(own, undefined, configured).source).toBe(
      "the pass command's own --model",
    );
  });

  it("names the setting an own --model came from when the configuration resolves to it", () => {
    const own = ["claude", "--model", "sonnet", ...PASS.slice(1)];
    expect(effectivePass(own, undefined, configured)).toEqual({
      argv: own,
      model: "sonnet",
      source: "the default, as the pass command's --model",
    });
  });

  it("reads an own --model that names no model as none", () => {
    for (const own of [
      ["claude", "--model=", ...PASS.slice(1)],
      ["claude", "--model", "", ...PASS.slice(1)],
    ]) {
      const pass = effectivePass(own, undefined, configured);
      expect([pass.model, pass.argv]).toEqual([null, own]);
      expect(pass.source).toContain("which names no model");
    }
  });

  it("names --pass-model alone when it names the model the pass command already carries", () => {
    const own = ["claude", "--model", "opus", ...PASS.slice(1)];
    const pass = effectivePass(own, "strategic", configured);
    expect([pass.argv, pass.source]).toEqual([
      own,
      "--pass-model: the strategic tier, routing.models.claude-code.strategic",
    ]);
  });

  it("lets --pass-model replace the pass command's own --model where it stands", () => {
    const own = ["claude", "-p", "/jig:drive-pr 7", "--model=haiku"];
    const pass = effectivePass(own, "opus", configured);
    expect(pass.argv).toEqual([
      "claude",
      "-p",
      "/jig:drive-pr 7",
      "--model",
      "opus",
    ]);
    expect(pass.source).toBe(
      "--pass-model, replacing the pass command's --model haiku",
    );
  });

  it("knows Claude Code's CLI by its program name, a full path or a Windows launcher", () => {
    for (const program of ["/home/me/.local/bin/claude", "claude.exe"])
      expect(
        effectivePass([program, "-p", "x 7"], undefined, configured).argv,
      ).toEqual([program, "--model", "sonnet", "-p", "x 7"]);
  });

  it("leaves another pass command to choose its own model", () => {
    const codex = ["codex", "exec", "/jig:drive-pr 7"];
    expect(effectivePass(codex, undefined, configured)).toEqual({
      argv: codex,
      model: null,
      source: "chosen by the pass command (codex)",
    });
    expect(() => effectivePass(codex, "sonnet", configured)).toThrow(
      PassModelUsageError,
    );
  });

  it("has nothing to decide without a pass command", () => {
    expect(effectivePass([], undefined, configured).model).toBeNull();
  });
});

describe("withoutModel", () => {
  it("drops a claude pass's --model, so a model id is never read as the PR", () => {
    expect(
      withoutModel(["claude", "--model", "claude-sonnet-4-5", "-p", "x"]),
    ).toEqual(["claude", "-p", "x"]);
    expect(
      withoutModel(["claude", "--model", "a", "--model=b", "-p", "x"]),
    ).toEqual(["claude", "-p", "x"]);
    expect(withoutModel(["codex", "--model", "4"])).toEqual([
      "codex",
      "--model",
      "4",
    ]);
  });
});

describe("a pass command naming --model twice", () => {
  it("ends with one --model, the flag's", () => {
    const pass = effectivePass(
      ["claude", "--model", "opus", "--model", "sonnet", "-p", "x"],
      "haiku",
      configured,
    );
    expect(pass.argv).toEqual(["claude", "--model", "haiku", "-p", "x"]);
  });
});

describe("the drives listing", () => {
  const diag = {
    pr: "7",
    worktree: "/w",
    log: "/l",
    started: "s",
    account: {
      account: null,
      vendor: null,
      provenance: "p",
      reason: "r",
    },
  };

  it("names the model a claim records, and says when the pass command chooses it", () => {
    const opus = parseClaimText(
      formatClaim(1, "h", { ...diag, model: "opus" }),
    );
    expect(opus?.diag?.model).toBe("opus");
    expect(diagLines(opus?.diag ?? diag)).toContain("    model:    opus");
    const own = parseClaimText(formatClaim(1, "h", { ...diag, model: null }));
    expect(diagLines(own?.diag ?? diag)).toContain(
      "    model:    chosen by the pass command",
    );
  });

  it("reads a claim from before the model, or with a malformed one, as unknown, keeping the rest", () => {
    const older = parseClaimText(formatClaim(1, "h", diag));
    expect(older?.diag).toEqual(diag);
    expect(diagLines(diag)).toContain(
      "    model:    unknown (claim predates the model)",
    );
    for (const model of [4, "", ["opus"]]) {
      const torn = parseClaimText(
        `1 h\n${JSON.stringify({ ...diag, model })}\n`,
      );
      expect(torn?.diag).toEqual(diag);
    }
  });
});
