import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHtml } from "../scripts/decision-sheet/html.ts";
import {
  renderComment,
  renderElaboration,
} from "../scripts/decision-sheet/markdown.ts";
import { parseSource } from "../scripts/decision-sheet/source.ts";

// Byte digests of each fixture's compact HTML, document HTML, comment and elaboration.
const digests = {
  pilot: [
    "2c7f93e971be562956076d660dbbe3486743a780090d75d92d6957f281b7da70",
    "c5d735235e7bfa6da463d9afbccf96cee1bccdfcdc6eb810cccb704b0af92a21",
    "145e6a5b3599fe0a57c1de2c427d8e33441c545ab4c8d267b43adf1f3d9c3ece",
    "02aaebf24912a88773c77ec1dbe6fb50b2a3cbebb1b3b1cd46b437dd01d7d303",
  ],
  "edge-cases": [
    "02395c747e8e1fc8db18bd998fbf983a1ea4a29a38c5344171c4178f70319e62",
    "ad9d6f8c367b2a484c92412708a7ecf8e32019e886752fda266462a08c0c4ca0",
    "2bb34b646b7d6eaf8ed1a345f3a782c978d07c785863af718be24fa98e461310",
    "c497a6f65ec4c0403dd11f56de5af5c9fa561c2e529ff176885961c842bbb519",
  ],
  multicall: [
    "b71595fae0532c81398d5eb5b00a1afcdba115f02d5118978cdf391f08b192c3",
    "9647e0331f3cc6ee1fdb7503419b5da114ad00281dc8341c55778bb3c7bf4ba3",
    "99e7255f311eea1b28ef0af80436c524f11de1f1b5ce53bca010e4f7698e93bf",
    "f030304d76f38ac56d9a09977d3c1318324bded38a54c41f8bc07b5f0a8119c3",
  ],
};

for (const [name, expected] of Object.entries(digests)) {
  test(`${name} renders every projection byte for byte`, () => {
    const source = parseSource(
      JSON.parse(
        readFileSync(
          join(import.meta.dir, "fixtures/decision-sheet", `${name}.json`),
          "utf8",
        ),
      ),
    );
    const projections = [
      renderHtml(source, "compact"),
      renderHtml(source, "document"),
      renderComment(source),
      renderElaboration(source),
    ];
    expect(
      projections.map((text) =>
        createHash("sha256").update(text).digest("hex"),
      ),
    ).toEqual(expected);
  });
}
