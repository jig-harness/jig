import { describe, expect, test } from "bun:test";
import { readSpecsConfig } from "../spec/config.ts";
import { resolveSpec, summary } from "../spec/resolve.ts";
import { issue, NO_USER_LAYER, put, scratchRepo } from "./spec-helpers.ts";

describe("verification commands", () => {
  test("drops list prefixes on indented code opened after a marker", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue(
        [
          "## Verification",
          "-     bun test",
          "- -     bun run check",
          "```sh",
          "-     preserve",
          "```",
        ].join("\n"),
      ),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.map((v) => v.text)).toEqual([
      "bun test",
      "bun run check",
      "-     preserve",
    ]);
  });
  test("removes compact nested list markers without changing fenced markers", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue(
        [
          "## Verification",
          "- - bun test",
          "- 1. `bun run check`",
          "```sh",
          "- - preserve",
          "--flag",
          "```",
        ].join("\n"),
      ),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.map((v) => v.text)).toEqual([
      "bun test",
      "bun run check",
      "- - preserve",
      "--flag",
    ]);
  });
  test("reads list items and fenced lines, preserving command text and source keys", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue(
        [
          "## Verification",
          "- `bun test src/check.test.ts`",
          "1. bun run check",
          "```sh",
          "printf '%s  %s' one two",
          "# a shell comment",
          "",
          "bun test --filter='a  b'",
          "```",
          "## Notes",
          "bun run outside",
        ].join("\n"),
      ),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.map((v) => v.text)).toEqual([
      "bun test src/check.test.ts",
      "bun run check",
      "printf '%s  %s' one two",
      "# a shell comment",
      "bun test --filter='a  b'",
    ]);
    for (const v of result.verification) {
      expect(v.key).toBe(`#body/Verification#${v.id}`);
      expect(result.sources[v.source]?.ref).toBe("#body/Verification");
      expect(summary(result)).toContain(`${v.key}: ${v.text}`);
    }
    expect(summary(result)).toContain("5 verification commands");
  });

  test("preserves command-significant whitespace and only unwraps complete code spans", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue(
        [
          "## Verification",
          "```sh",
          "printf '%s\\n' a\\ ",
          "```",
          "`echo hello",
          "echo hello`",
          "`echo` `hello`",
          "``echo `hello` ``",
        ].join("\n"),
      ),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.map((v) => v.text)).toEqual([
      "printf '%s\\n' a\\ ",
      "`echo hello",
      "echo hello`",
      "`echo` `hello`",
      "echo `hello` ",
    ]);
  });

  test("assigns duplicate command ids without rescanning earlier suffixes", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue(["## Verification", ...Array(20).fill("bun test")].join("\n")),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.at(-1)?.id).toBe(
      `${result.verification[0]?.id}~20`,
    );
  });

  test("uses the configured heading with the same matching rules as Spec", async () => {
    const { root } = scratchRepo("spec-verification-");
    put(root, ".config/jig.yaml", "specs:\n  verification_section: Checks\n");
    const result = await resolveSpec(
      issue(
        "### **CHECKS:**\n\nbun run check\n\n### Verification\n\nbun run ignored\n",
      ),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.map((v) => v.text)).toEqual(["bun run check"]);
    expect(result.sources[0]?.ref).toBe("#body/Checks");
  });

  test("no section produces an empty list, and headings inside code open no section", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue("```md\n## Verification\nbun run example\n```\n"),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  test("repeated and nested sections keep commands once per occurrence and code syntax intact", async () => {
    const { root } = scratchRepo("spec-verification-");
    const result = await resolveSpec(
      issue(
        [
          "## Spec",
          "### Verification",
          "- bun test",
          "```sh",
          "printf 'a\tb'",
          "--flag",
          "```",
          "### Acceptance criteria",
          "- Works",
          "## Verification",
          "- bun test",
          "## Notes",
          "bun run outside",
        ].join("\n"),
      ),
      root,
      { env: NO_USER_LAYER },
    );
    expect(result.verification.map((v) => v.text)).toEqual([
      "bun test",
      "printf 'a\tb'",
      "--flag",
      "bun test",
    ]);
    expect(result.verification[3]?.id).toBe(`${result.verification[0]?.id}~2`);
    expect(result.acceptance.map((v) => v.text)).toEqual(["Works"]);
  });

  test("rejects invalid or colliding headings and repository settings in a user file", () => {
    const { root, outside } = scratchRepo("spec-verification-");
    for (const value of [
      "'## Checks'",
      "'Requirements:'",
      "'Acceptance criteria'",
      "Spec",
      "''",
    ]) {
      put(
        root,
        ".config/jig.yaml",
        `specs:\n  verification_section: ${value}\n`,
      );
      expect(() => readSpecsConfig(root, ["body"], NO_USER_LAYER)).toThrow(
        "specs.verification_section",
      );
    }
    put(
      root,
      ".config/jig.yaml",
      "specs:\n  body_section: Checks\n  verification_section: checks\n",
    );
    expect(() => readSpecsConfig(root, ["body"], NO_USER_LAYER)).toThrow(
      "must differ",
    );
    put(root, ".config/jig.yaml", "specs:\n  verification_section: null\n");
    expect(
      readSpecsConfig(root, ["body"], NO_USER_LAYER).verificationSection,
    ).toBe("Verification");
    put(outside, "jig.yaml", "specs:\n  verification_section: Checks\n");
    expect(() =>
      readSpecsConfig(root, ["body"], { JIG_HOME: outside }),
    ).toThrow("specs.verification_section describes one repository");
  });
});
