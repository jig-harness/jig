import { describe, expect, it } from "bun:test";
import {
  BUILTIN_FORMATS,
  jigFormats,
  jigSeverityOf,
  normalizeLogin,
  parseSeverityFormats,
  type SeverityFormat,
  severityOf,
} from "../scripts/lib/severity-formats.ts";

const CUSTOM: SeverityFormat = {
  login: "example-reviewer[bot]",
  shape: "bold-token",
  severities: { Critical: "blocker", Major: "high", Nit: "low" },
};

describe("severityOf", () => {
  it("reads a format only from its own login, [bot] suffix and case aside", () => {
    const formats = [CUSTOM];
    const body = "🔴 **Critical** · the cache is never invalidated";
    expect(severityOf(body, "example-reviewer", formats)).toBe("blocker");
    expect(severityOf(body, "Example-Reviewer[bot]", formats)).toBe("blocker");
    expect(severityOf(body, "someone-else", formats)).toBe("unknown");
    expect(severityOf(body, null, formats)).toBe("unknown");
    expect(severityOf(body, undefined, formats)).toBe("unknown");
  });

  it("matches the reviewer's words case-insensitively and nothing else", () => {
    const formats = [CUSTOM];
    expect(severityOf("**major** · x", "example-reviewer", formats)).toBe(
      "high",
    );
    expect(severityOf("**Majority** · x", "example-reviewer", formats)).toBe(
      "unknown",
    );
    // Jig's own words are not this reviewer's.
    expect(severityOf("**high** · x", "example-reviewer", formats)).toBe(
      "unknown",
    );
  });

  it("tries a repository's formats before the built-in ones for the same login", () => {
    const override: SeverityFormat = {
      login: "coderabbitai",
      shape: "bold-token",
      severities: { Urgent: "blocker" },
    };
    const formats = [override, ...BUILTIN_FORMATS];
    expect(severityOf("**Urgent** title", "coderabbitai", formats)).toBe(
      "blocker",
    );
    // The built-in format still reads what the override does not.
    expect(
      severityOf(
        "**🔒 Security** | **🟠 Major** | **⚡ Quick win**",
        "coderabbitai",
        formats,
      ),
    ).toBe("high");
  });

  it("reads CodeRabbit's icon-led layout, with or without an effort field", () => {
    const icon =
      '<picture><img src="https://x.invalid/major-16.svg" width="16" alt=""></picture>';
    const read = (body: string) =>
      severityOf(body, "coderabbitai[bot]", BUILTIN_FORMATS);
    expect(
      read(`**${icon} Major** · **Stability** · **Heavy lift**\n\nx`),
    ).toBe("high");
    expect(read(`**${icon} Trivial** · **Security & Privacy**\n\nx`)).toBe(
      "low",
    );
    expect(read(`**${icon} Minor** · **Quality** · **Quick win**`)).toBe("low");
    expect(read("**Major** · prose, not a field")).toBe("unknown");
    // Its comments open with a marker the severity follows.
    const marker = "<!-- coderabbit-ai-generated:v1 -->";
    expect(
      read(`${marker}\n**${icon} Major** · **Stability** · **Quick win**\n\nx`),
    ).toBe("high");
    expect(read(`${marker}\n\nThanks, the guard covers it now.`)).toBe(
      "unknown",
    );
    expect(
      severityOf(`**${icon} Major** · **A**`, "someone-else", BUILTIN_FORMATS),
    ).toBe("unknown");
  });

  it("reads each shape with a configured vocabulary", () => {
    const badge: SeverityFormat = {
      login: "badge-bot",
      shape: "badge",
      severities: { Sev1: "blocker", Sev2: "medium" },
    };
    const pipes: SeverityFormat = {
      login: "pipe-bot",
      shape: "pipe-fields",
      severities: { Blocking: "blocker" },
    };
    const formats = [badge, pipes];
    expect(
      severityOf(
        "**![Sev2 Badge](https://x.invalid)** title",
        "badge-bot",
        formats,
      ),
    ).toBe("medium");
    expect(severityOf("![Sev3 Badge](…) title", "badge-bot", formats)).toBe(
      "unknown",
    );
    expect(
      severityOf("_Bug_ | _🔴 Blocking_ | _Small_", "pipe-bot", formats),
    ).toBe("blocker");
    expect(severityOf("_Bug_ | _🔴 Blocking_", "pipe-bot", formats)).toBe(
      "unknown",
    );
  });

  it("reads Jig's own format for the configured reviewer's logins only", () => {
    const formats = jigFormats(["example-review"]);
    expect(severityOf("🟡 **medium** · x", "example-review", formats)).toBe(
      "medium",
    );
    expect(severityOf("🟡 **medium** · x", "other-bot", formats)).toBe(
      "unknown",
    );
  });
});

describe("Greptile's built-in format", () => {
  const GREPTILE = "greptile-apps";
  const badge = (level: string) =>
    `<a href="#"><img alt="${level}" src="https://example.invalid/badges/${level.toLowerCase()}.svg?v=9" align="top"></a>`;
  const read = (body: string, login = GREPTILE) =>
    severityOf(body, login, BUILTIN_FORMATS);

  it("reads the priority badge in the shapes its comments take", () => {
    // Title on its own paragraph, the usual shape.
    expect(read(`${badge("P1")} **Retry loop never ends**\n\nDetails.`)).toBe(
      "high",
    );
    // The title's prose on the same line.
    expect(read(`${badge("P2")} **Slow path** The loop reads twice.`)).toBe(
      "medium",
    );
    // A category badge between the priority badge and the title.
    const category =
      '<a href="#"><img alt="security" src="https://example.invalid/badges/Security.svg?v=2" align="top"></a>';
    expect(read(`${badge("P0")} ${category} **Token is logged**`)).toBe(
      "blocker",
    );
    // Its login as the REST API spells it.
    expect(read(`${badge("P1")} **Title**`, "greptile-apps[bot]")).toBe("high");
  });

  it("reads nothing it was not given, from anyone else, or off line 0", () => {
    // Greptile's scale has no P3.
    expect(read(`${badge("P3")} **Title**`)).toBe("unknown");
    // The same HTML from another login.
    expect(read(`${badge("P0")} **Title**`, "someone-else")).toBe("unknown");
    // A badge quoted in the body, or after prose on line 0.
    expect(read(`**Title**\n\nIt renders ${badge("P0")} here.`)).toBe(
      "unknown",
    );
    expect(read(`See ${badge("P0")} for the scale`)).toBe("unknown");
    expect(read(`\n${badge("P0")} **Title**`)).toBe("unknown");
    // `alt` must be the attribute itself.
    expect(read('<a href="#"><img data-alt="P0" src="x"></a> **Title**')).toBe(
      "unknown",
    );
    // A tag left open on line 0 is not a badge.
    expect(read('<img src="x"\nalt="P0"> **Title**')).toBe("unknown");
    // Text inside another attribute's value is not an attribute.
    expect(read(`<img title=' alt="P2" ' src="x"> **Title**`)).toBe("unknown");
    expect(read(`<a title='> <img alt="P0">'><img src="x"></a>`)).toBe(
      "unknown",
    );
    // A tag whose name only starts with `img`.
    expect(read('<img-widget alt="P2"> **Title**')).toBe("unknown");
  });

  it("reads the alt attribute itself, whatever else the tag carries", () => {
    expect(read(`<img alt="P0" title=' alt="P2" ' src="x"> **Title**`)).toBe(
      "blocker",
    );
    expect(read("<img src=x alt='p1'/> **Title**")).toBe("high");
    // A repeated attribute: the first one is the attribute.
    expect(read('<img alt="P2" alt="P0"> **Title**')).toBe("medium");
  });
});

describe("jigSeverityOf", () => {
  it("reads Jig's format past its leading markers, and nothing else", () => {
    expect(jigSeverityOf("<!-- ai-review-fp: abc -->\n🟠 **HIGH** · x")).toBe(
      "high",
    );
    expect(jigSeverityOf("![P1 Badge](…) title")).toBe("unknown");
    expect(jigSeverityOf("Fix the **blocker** token")).toBe("unknown");
  });
});

describe("normalizeLogin", () => {
  it("drops a [bot] suffix and case", () => {
    expect(normalizeLogin(" CodeRabbitAI[bot] ")).toBe("coderabbitai");
    expect(normalizeLogin("coderabbitai")).toBe("coderabbitai");
  });
});

describe("parseSeverityFormats", () => {
  const valid = {
    login: "example-reviewer[bot]",
    shape: "badge",
    severities: { P0: "blocker", "Sev 1": "high" },
  };

  it("reads absent as no formats and keeps a valid entry", () => {
    expect(parseSeverityFormats(undefined)).toEqual([]);
    expect(parseSeverityFormats(null)).toEqual([]);
    expect(parseSeverityFormats([valid])).toEqual([
      valid as unknown as SeverityFormat,
    ]);
  });

  const refused: [string, unknown, string][] = [
    ["a non-list", { login: "x" }, "must be a list"],
    ["a non-mapping entry", ["x"], "[0] must be a mapping"],
    ["an unknown field", [{ ...valid, words: {} }], "unknown field(s) words"],
    ["an empty login", [{ ...valid, login: " [bot]" }], "[0].login"],
    ["an unknown shape", [{ ...valid, shape: "regex" }], "[0].shape"],
    ["no severities", [{ ...valid, severities: {} }], "must not be empty"],
    [
      "a word with markup",
      [{ ...valid, severities: { "**P0**": "blocker" } }],
      "letters and digits",
    ],
    [
      "a word listed twice",
      [{ ...valid, severities: { p0: "blocker", P0: "high" } }],
      "listed twice",
    ],
    [
      "a severity Jig does not have",
      [{ ...valid, severities: { P0: "critical" } }],
      "severities.P0 must be one of blocker, high, medium, low",
    ],
  ];
  for (const [what, raw, message] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => parseSeverityFormats(raw, "test")).toThrow(message);
    });
  }
});
