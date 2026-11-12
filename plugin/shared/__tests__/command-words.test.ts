import { describe, expect, it } from "bun:test";
import { splitCommandWords } from "../command-words.ts";

describe("splitCommandWords", () => {
  it("splits on spaces and keeps quoted stretches whole, with no shell", () => {
    expect(
      splitCommandWords(`vault read -field=token "secret/jira token" '$HOME'`),
    ).toEqual({
      ok: true,
      value: ["vault", "read", "-field=token", "secret/jira token", "$HOME"],
    });
    expect(splitCommandWords(`a"b c"d  e`)).toEqual({
      ok: true,
      value: ["ab cd", "e"],
    });
    expect(splitCommandWords("   ")).toEqual({ ok: true, value: [] });
  });

  it("refuses an unclosed quote without repeating the line", () => {
    const words = splitCommandWords(`helper --key "s3cret`);
    expect(words.ok).toBe(false);
    if (words.ok) return;
    expect(words.failure).toEqual({
      code: "unclosed-quote",
      reason: 'unclosed "',
    });
  });
});
