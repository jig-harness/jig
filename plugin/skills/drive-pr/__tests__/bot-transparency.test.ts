/**
 * The transparent follow-up after a held reply (`lib/bot-confirmation.ts`):
 * a listed review bot's confirmation, or its chat acknowledgement carrying
 * no outcome token and no finding, is transparent; anything else is a newer
 * comment the guard refuses and the round triages.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseReviewConfig } from "../../../shared/consumer.ts";
import {
  botMarkers,
  CODERABBIT_CHAT_MARKER,
  CODERABBIT_CONFIRMATION_MARKER,
  isTransparentFollowUp,
} from "../scripts/lib/bot-confirmation.ts";
import { qualifyingOutcome } from "../scripts/lib/outcome.ts";
import {
  BUILTIN_FORMATS,
  jigFormats,
} from "../scripts/lib/severity-formats.ts";

const SCRIPTS = join(import.meta.dir, "../scripts");

const listed = botMarkers(["coderabbitai[bot]", "example-review[bot]"]);

function transparent(
  authorLogin: string | null,
  body: string,
  bots = listed,
): boolean {
  return isTransparentFollowUp(
    { authorLogin, body },
    qualifyingOutcome,
    bots,
    BUILTIN_FORMATS,
  );
}

/**
 * `example-review`'s chat replies read through the default configuration
 * resolver, in a subprocess given an overlay that lists the bot with a chat
 * marker, `reviewerApp` as `review.reviewer_app`, and with `declared` a
 * `review.severity_formats` entry giving the bot Jig's format.
 * The replies: a finding in a shape no format of the bot's reads, one in
 * Jig's shape, and a plain acknowledgement.
 */
function readsThroughConfig(
  reviewerApp: string | null,
  declared = false,
): boolean[] {
  const dir = mkdtempSync(join(tmpdir(), "bot-transparency-"));
  try {
    const overlay = join(dir, "overlay.yaml");
    writeFileSync(
      overlay,
      [
        "review:",
        ...(reviewerApp === null ? [] : [`  reviewer_app: "${reviewerApp}"`]),
        "  bots:",
        '    - login: "example-review[bot]"',
        '      chat_marker: "<!-- example-chat -->"',
        ...(declared
          ? [
              "  severity_formats:",
              '    - login: "example-review[bot]"',
              "      shape: bold-token",
              "      severities: { blocker: blocker, high: high, medium: medium, low: low }",
            ]
          : []),
      ].join("\n"),
    );
    const script = [
      `import { isTransparentFollowUp } from ${JSON.stringify(join(SCRIPTS, "lib/bot-confirmation.ts"))};`,
      `import { qualifyingOutcome } from ${JSON.stringify(join(SCRIPTS, "lib/outcome.ts"))};`,
      "const reads = [",
      '  "<!-- example-chat -->\\n[P1] The authorization guard is still missing",',
      '  "<!-- example-chat -->\\n🟠 **high** · 🏷️ category: correctness",',
      '  "<!-- example-chat -->\\nNoted.",',
      '].map((body) => isTransparentFollowUp({ authorLogin: "example-review", body }, qualifyingOutcome));',
      "console.log(JSON.stringify(reads));",
    ].join("\n");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith("DRIVE_PR_") && !k.startsWith("JIG__"),
      ),
    );
    const result = spawnSync("bun", ["-e", script], {
      cwd: dir,
      env: { ...env, JIG_OVERLAY: overlay },
      encoding: "utf8",
    });
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      0,
    );
    return JSON.parse(result.stdout.trim()) as boolean[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ACKNOWLEDGEMENT = [
  CODERABBIT_CHAT_MARKER,
  "`@example-author` Thanks for the update: the fix is noted and nothing further is requested on this thread.",
  "",
  "> **accepted** — fixed the missing guard; not yet pushed.",
].join("\n");

describe("a transparent follow-up", () => {
  test("a listed bot's chat acknowledgement with no outcome token and no severity line", () => {
    expect(transparent("coderabbitai", ACKNOWLEDGEMENT)).toBe(true);
  });

  test("the login matches without regard to case or a [bot] suffix", () => {
    expect(transparent("CodeRabbitAI[bot]", ACKNOWLEDGEMENT)).toBe(true);
  });

  test("a listed bot's confirmation", () => {
    expect(
      transparent(
        "coderabbitai",
        `${CODERABBIT_CONFIRMATION_MARKER}\nConfirmed: synchronized as addressed.`,
      ),
    ).toBe(true);
  });

  test("a bot's own markers from its review.bots entry, with a severity format for it", () => {
    const bots = botMarkers([
      { login: "example-review[bot]", chat_marker: "<!-- example-chat -->" },
    ]);
    expect(
      isTransparentFollowUp(
        {
          authorLogin: "example-review",
          body: "<!-- example-chat -->\nNoted.",
        },
        qualifyingOutcome,
        bots,
        [...BUILTIN_FORMATS, ...jigFormats(["example-review[bot]"])],
      ),
    ).toBe(true);
  });

  test("a measured confirmation marker applies though review.bots leaves the bot out", () => {
    const confirmation = `${CODERABBIT_CONFIRMATION_MARKER}\nConfirmed.`;
    expect(
      transparent("coderabbitai", confirmation, botMarkers(undefined)),
    ).toBe(true);
    expect(
      transparent(
        "coderabbitai",
        confirmation,
        botMarkers(["example-review[bot]"]),
      ),
    ).toBe(true);
  });
});

describe("a newer comment, never transparent", () => {
  test("a finding inside an acknowledgement", () => {
    const body = [
      CODERABBIT_CHAT_MARKER,
      "Thanks for the update. One more thing on this line:",
      "",
      "_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_",
      "",
      "The guard still reads the unvalidated value.",
    ].join("\n");
    expect(transparent("coderabbitai", body)).toBe(false);
  });

  test("a finding in the icon-fields shape inside an acknowledgement", () => {
    const body = `${CODERABBIT_CHAT_MARKER}\nNoted.\n\n**<picture><img alt="Major" src="x"></picture> Major** · **Correctness**\n\nStill wrong.`;
    expect(transparent("coderabbitai", body)).toBe(false);
  });

  test("a chat reply from a listed bot no severity format reads", () => {
    const bots = botMarkers([
      { login: "example-review[bot]", chat_marker: "<!-- example-chat -->" },
    ]);
    for (const body of [
      "<!-- example-chat -->\n🟠 **high** — the guard still permits unauthorized requests",
      "<!-- example-chat -->\nNoted.",
    ]) {
      expect(transparent("example-review", body, bots)).toBe(false);
    }
  });

  test("a chat reply from a listed bot whose only format is Jig's, assumed", () => {
    expect(readsThroughConfig(null)).toEqual([false, false, false]);
    // Naming the bot as review.reviewer_app does not make the format its own.
    expect(readsThroughConfig("example-review[bot]")).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("a declared format makes the bot's chat acknowledgement transparent", () => {
    expect(readsThroughConfig("example-review[bot]", true)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("an acknowledgement from an author review.bots does not list", () => {
    const bots = botMarkers(["example-review[bot]"]);
    expect(transparent("coderabbitai", ACKNOWLEDGEMENT, bots)).toBe(false);
  });

  test("an acknowledgement when review.bots is not set", () => {
    expect(
      transparent("coderabbitai", ACKNOWLEDGEMENT, botMarkers(undefined)),
    ).toBe(false);
  });

  test("a person's comment carrying the marker", () => {
    expect(transparent("example-author", ACKNOWLEDGEMENT)).toBe(false);
  });

  test("a listed bot's body with neither marker", () => {
    expect(
      transparent("coderabbitai", "Thanks, nothing further requested."),
    ).toBe(false);
  });

  test("an acknowledgement opening a line with an outcome token", () => {
    expect(
      transparent(
        "coderabbitai",
        `${CODERABBIT_CHAT_MARKER}\n**rejected** — the guard is still missing.`,
      ),
    ).toBe(false);
  });

  test("a deleted account", () => {
    expect(transparent(null, ACKNOWLEDGEMENT)).toBe(false);
  });

  test("a finding from a bot whose entry declares an empty or wrong-typed marker", () => {
    const finding = "_⚠️ Potential issue_ | _🟠 Major_\n\nStill wrong.";
    for (const marker of ["", "  ", 7])
      for (const field of ["confirmation_marker", "chat_marker"]) {
        const bots = botMarkers([
          { login: "example-review[bot]", [field]: marker } as never,
        ]);
        expect(transparent("example-review", finding, bots)).toBe(false);
        expect(transparent("example-review", "Noted.", bots)).toBe(false);
      }
  });
});

describe("review.bots entries", () => {
  test("accept a login or a mapping with markers", () => {
    expect(
      parseReviewConfig({
        bots: [
          "example-review[bot]",
          {
            login: "coderabbitai[bot]",
            confirmation_marker: "<!-- c -->",
            chat_marker: "<!-- d -->",
          },
        ],
      }).bots,
    ).toHaveLength(2);
  });

  test("refuse a mapping with an unknown key or an empty marker", () => {
    expect(() =>
      parseReviewConfig({ bots: [{ login: "a", override: true }] }),
    ).toThrow(/review.bots/);
    expect(() =>
      parseReviewConfig({ bots: [{ login: "a", chat_marker: " " }] }),
    ).toThrow(/review.bots/);
  });
});
