/**
 * The transparent follow-up after a held reply (`lib/bot-confirmation.ts`):
 * a listed review bot's confirmation, or its chat acknowledgement carrying
 * no outcome token and no finding, is transparent; anything else is a newer
 * comment the guard refuses and the round triages.
 */
import { describe, expect, test } from "bun:test";
import { parseReviewConfig } from "../../../shared/consumer.ts";
import {
  botMarkers,
  CODERABBIT_CHAT_MARKER,
  CODERABBIT_CONFIRMATION_MARKER,
  isTransparentFollowUp,
} from "../scripts/lib/bot-confirmation.ts";
import { qualifyingOutcome } from "../scripts/lib/outcome.ts";
import { BUILTIN_FORMATS } from "../scripts/lib/severity-formats.ts";

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

  test("a bot's own markers from its review.bots entry", () => {
    const bots = botMarkers([
      { login: "example-review[bot]", chat_marker: "<!-- example-chat -->" },
    ]);
    expect(
      transparent("example-review", "<!-- example-chat -->\nNoted.", bots),
    ).toBe(true);
  });

  test("with no review.bots, the built-in entries apply", () => {
    expect(
      transparent("coderabbitai", ACKNOWLEDGEMENT, botMarkers(undefined)),
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

  test("an acknowledgement from an author review.bots does not list", () => {
    const bots = botMarkers(["example-review[bot]"]);
    expect(transparent("coderabbitai", ACKNOWLEDGEMENT, bots)).toBe(false);
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
