/**
 * PR-scoped capture of the Refocus intent chain: a pin is written
 * only when the chain provably belongs to the PR, is first-write-wins, and —
 * once written — outlives the two substitutions an identifier key cannot stop
 * (a moved `.current`, an overwritten alias).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePickup } from "../../do-issue/scripts/lib/intent-chain-pickup.ts";
import {
  type CaptureInput,
  captureIntentChain,
  prClaimsIdentifier,
} from "../scripts/lib/intent-chain-capture.ts";
import { topLevelParagraphs } from "../scripts/lib/markdown-paragraphs.ts";
import {
  INTENT_CHAIN_POINTER,
  INTENT_CHAIN_SUBDIR,
  intentChainSection,
  prCaptureFileName,
} from "../scripts/lib/state/handoff.ts";

let ctx: string;
let pickups: Map<string, string>;
const savedOverlay = process.env.GROUNDWORK_OVERLAY;
beforeEach(() => {
  ctx = mkdtempSync(join(tmpdir(), "intent-chain-capture-"));
  pickups = new Map();
  // Branch names carry the consumer's team key (ENG here).
  process.env.GROUNDWORK_OVERLAY = join(
    import.meta.dir,
    "fixtures",
    "tracker-overlay.yaml",
  );
});
afterEach(() => {
  rmSync(ctx, { recursive: true, force: true });
  if (savedOverlay === undefined) delete process.env.GROUNDWORK_OVERLAY;
  else process.env.GROUNDWORK_OVERLAY = savedOverlay;
});

const chainDir = () => join(ctx, INTENT_CHAIN_SUBDIR);
const snapshot = (id: string, body: string, aliases: string[] = []) => {
  mkdirSync(chainDir(), { recursive: true });
  const text = `<!-- refocus-arm: on -->\n# Intent chain\n\n${body}\n`;
  for (const identifier of [id, ...aliases]) {
    writeFileSync(join(chainDir(), `${identifier}.md`), text);
  }
  const token = writePickup(chainDir(), [id, ...aliases], text);
  for (const identifier of [id, ...aliases]) pickups.set(identifier, token);
  return token;
};
const point = (id: string) =>
  writeFileSync(join(chainDir(), INTENT_CHAIN_POINTER), id);
const pinPath = (pr = "42") => join(chainDir(), prCaptureFileName(pr));

const base = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  pr: "42",
  state: "OPEN",
  headRefName: "feature/ENG-7-thing",
  title: "fix(x): a thing",
  body: "",
  checkedOutBranch: "feature/ENG-7-thing",
  contextDir: ctx,
  refresh: false,
  pickupId: pickups.get("ENG-7"),
  ...over,
});

describe("prClaimsIdentifier", () => {
  it("a CRLF trailer line is a claim", () => {
    expect(
      prClaimsIdentifier("ENG-7", "fix: y", "text\r\n\r\nCloses ENG-7\r\n"),
    ).toBe(true);
  });
  it("accepts the title and trailer lines, in any case", () => {
    expect(prClaimsIdentifier("ENG-7", "fix: y (ENG-7)", "")).toBe(true);
    expect(
      prClaimsIdentifier("ENG-7", "fix: y", "text\n\nCloses eng-7\n"),
    ).toBe(true);
    expect(
      prClaimsIdentifier("ENG-7", "fix: y", "References: ENG-3, ENG-7"),
    ).toBe(true);
  });

  it("accepts Fixes/Resolves trailers, colon or not, several ids per line", () => {
    expect(prClaimsIdentifier("ENG-7", "x", "Fixes: ENG-7")).toBe(true);
    expect(prClaimsIdentifier("ENG-7", "x", "Resolves ENG-3 and ENG-7")).toBe(
      true,
    );
    expect(
      prClaimsIdentifier("ENG-7", "x", "first\n  Closes ENG-3 & ENG-7  \nlast"),
    ).toBe(true);
  });

  it("refuses prose that merely starts with a trailer keyword", () => {
    expect(
      prClaimsIdentifier(
        "ENG-9",
        "x",
        "Fixes the flake that ENG-9 introduced.",
      ),
    ).toBe(false);
    expect(
      prClaimsIdentifier("ENG-9", "x", "References the ENG-9 design"),
    ).toBe(false);
  });

  it("refuses a bare mention, and a longer number sharing the prefix", () => {
    expect(prClaimsIdentifier("ENG-7", "fix: y", "see ENG-7 for context")).toBe(
      false,
    );
    expect(prClaimsIdentifier("ENG-7", "fix: ENG-70", "Closes ENG-77")).toBe(
      false,
    );
    expect(prClaimsIdentifier("ENG-7", "fix: XENG-7", "")).toBe(false);
  });

  it("refuses a letter suffix on the identifier, in title or trailer", () => {
    expect(prClaimsIdentifier("ENG-7", "fix: ENG-7x", "")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "Closes ENG-7b")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "fix: ENG-7: y", "")).toBe(true);
  });

  it("does not glue identifiers across a newline or with no separator", () => {
    expect(prClaimsIdentifier("ENG-7", "x", "Closes ENG-3\nENG-7")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "Closes\nENG-7")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "Closes ENG-3ENG-7")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "Closes ENG-3 ENG-7")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "Closes ENG-3, ENG-7")).toBe(true);
    expect(prClaimsIdentifier("ENG-7", "x", "Closes ENG-3 and ENG-7")).toBe(
      true,
    );
  });

  it("ignores a trailer-shaped line inside a fence or a quote", () => {
    expect(
      prClaimsIdentifier("ENG-9", "x", "Example:\n```\nReferences: ENG-9\n```"),
    ).toBe(false);
    expect(prClaimsIdentifier("ENG-9", "x", "~~~md\nCloses ENG-9\n~~~\n")).toBe(
      false,
    );
    expect(prClaimsIdentifier("ENG-9", "x", "> Closes ENG-9")).toBe(false);
    // An unterminated fence swallows the rest, and a closed one ends.
    expect(prClaimsIdentifier("ENG-9", "x", "```\nCloses ENG-9")).toBe(false);
    expect(
      prClaimsIdentifier("ENG-9", "x", "```\nsample\n```\nCloses ENG-9"),
    ).toBe(true);
  });

  it("closes a fence only on the same character at least as long as its opener", () => {
    // A shorter run, or the other character, stays inside the block.
    expect(
      prClaimsIdentifier("ENG-7", "x", "````\n```\nCloses ENG-7\n````"),
    ).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "```\n~~~\nCloses ENG-7")).toBe(
      false,
    );
    // An equal-or-longer close ends it.
    expect(prClaimsIdentifier("ENG-7", "x", "```\nx\n````\nCloses ENG-7")).toBe(
      true,
    );
    expect(
      prClaimsIdentifier("ENG-7", "x", "````\nx\n````\nCloses ENG-7"),
    ).toBe(true);
  });

  it("ignores a trailer-shaped line in indented code, not one indented 1-3 spaces", () => {
    expect(
      prClaimsIdentifier("ENG-7", "x", "Example:\n\n    Closes ENG-7"),
    ).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "\tCloses ENG-7")).toBe(false);
    expect(prClaimsIdentifier("ENG-7", "x", "   Closes ENG-7")).toBe(true);
  });
});

describe("prClaimsIdentifier — non-claim contexts", () => {
  it("ignores a trailer inside an HTML comment or a quote lazy continuation", () => {
    expect(prClaimsIdentifier("ENG-7", "x", "<!--\nCloses ENG-7\n-->")).toBe(
      false,
    );
    expect(prClaimsIdentifier("ENG-7", "x", "> quoted\nCloses ENG-7")).toBe(
      false,
    );
    // Visible prose after the comment or quote has closed still counts.
    expect(
      prClaimsIdentifier("ENG-7", "x", "<!-- note -->\n\nCloses ENG-7"),
    ).toBe(true);
    expect(prClaimsIdentifier("ENG-7", "x", "> quoted\n\nCloses ENG-7")).toBe(
      true,
    );
  });

  it("ignores a trailer that is a heading, a list item or inside an HTML block", () => {
    const claims = (body: string) => prClaimsIdentifier("ENG-12", "x", body);
    expect(claims("Closes ENG-12\n===")).toBe(false);
    expect(claims("Closes ENG-12\n---")).toBe(false);
    expect(claims("- Closes ENG-12")).toBe(false);
    expect(claims("- item\nCloses ENG-12")).toBe(false);
    expect(claims("1. item\n   Closes ENG-12")).toBe(false);
    expect(claims("<details>\nCloses ENG-12\n</details>")).toBe(false);
    expect(claims("<!--\nCloses ENG-12")).toBe(false);
  });

  it("accepts a trailer the surrounding block does not swallow", () => {
    const claims = (body: string) => prClaimsIdentifier("ENG-12", "x", body);
    // Indented code cannot interrupt a paragraph: this is its next line.
    expect(claims("Summary.\n    Closes ENG-12")).toBe(true);
    expect(claims("- item\n\nCloses ENG-12")).toBe(true);
    expect(claims("<details>\n\nCloses ENG-12\n\n</details>")).toBe(true);
    // A link reference definition is not part of the paragraph after it.
    expect(claims("[spec]: https://example.com\nCloses ENG-12")).toBe(true);
  });
});

describe("topLevelParagraphs", () => {
  const paragraphs = topLevelParagraphs;

  it("returns each paragraph's raw source, from its first non-blank character", () => {
    expect(paragraphs("a\nb\n\nc")).toEqual(["a\nb", "c"]);
    expect(paragraphs("  a  \n   b")).toEqual(["a  \n   b"]);
    expect(paragraphs("a\r\nb\r\n\r\nc\rd")).toEqual(["a\r\nb", "c\rd"]);
    expect(paragraphs("﻿a")).toEqual(["a"]);
    expect(paragraphs("")).toEqual([]);
  });

  it("drops fenced code, closed only by the same character at least as long", () => {
    expect(paragraphs("```\nx\n```\nb")).toEqual(["b"]);
    expect(paragraphs("````\n```\nx\n````\nb")).toEqual(["b"]);
    expect(paragraphs("~~~\n```\nx")).toEqual([]);
    expect(paragraphs("   ```\nx\n   ```\nb")).toEqual(["b"]);
    // Indented four spaces, a closing fence is code.
    expect(paragraphs("```\nx\n    ```\nb")).toEqual([]);
    // A backtick fence's info string cannot hold a backtick.
    expect(paragraphs("``` a`b\nx")).toEqual(["``` a`b\nx"]);
  });

  it("drops indented code, which cannot interrupt a paragraph", () => {
    expect(paragraphs("    x\n\nb")).toEqual(["b"]);
    expect(paragraphs("\tx")).toEqual([]);
    expect(paragraphs("a\n    b")).toEqual(["a\n    b"]);
  });

  it("drops HTML blocks of every start condition, to their end condition", () => {
    expect(paragraphs("<script>\na\n\nb\n</script>\nc")).toEqual(["c"]);
    expect(paragraphs("<!-- a\n\nb -->\nc")).toEqual(["c"]);
    expect(paragraphs("<?php\n\nx ?>\nc")).toEqual(["c"]);
    expect(paragraphs("<!DOCTYPE html>\nc")).toEqual(["c"]);
    expect(paragraphs("<![CDATA[\n\nx]]>\nc")).toEqual(["c"]);
    expect(paragraphs("<div>\na\n\nb")).toEqual(["b"]);
    expect(paragraphs("<x-y>\na\n\nb")).toEqual(["b"]);
    expect(paragraphs("a\n<div>")).toEqual(["a"]);
    // A complete tag of any other name cannot interrupt a paragraph.
    expect(paragraphs("a\n<x-y>")).toEqual(["a\n<x-y>"]);
  });

  it("drops ATX and setext headings and thematic breaks", () => {
    expect(paragraphs("# a\nb")).toEqual(["b"]);
    expect(paragraphs("a\n===\nb")).toEqual(["b"]);
    expect(paragraphs("a\n---")).toEqual([]);
    expect(paragraphs("a\n\n---")).toEqual(["a"]);
    expect(paragraphs("***\na")).toEqual(["a"]);
    expect(paragraphs("a\n***\nb")).toEqual(["a", "b"]);
  });

  it("drops block quotes, lazy continuation lines included", () => {
    expect(paragraphs("> a\nb")).toEqual([]);
    expect(paragraphs("> a\n\nb")).toEqual(["b"]);
    // Only paragraph text continues lazily: a quoted fence ends with the quote.
    expect(paragraphs("> ```\nb")).toEqual(["b"]);
    expect(paragraphs(">     x\nb")).toEqual(["b"]);
  });

  it("drops list items, by their content indentation and lazy continuation", () => {
    expect(paragraphs("- a\nb")).toEqual([]);
    expect(paragraphs("- a\n\nb")).toEqual(["b"]);
    expect(paragraphs("- a\n\n  b\n\nc")).toEqual(["c"]);
    expect(paragraphs("1. a\n   b")).toEqual([]);
    expect(paragraphs("-\ta\n\n\tb\n\nc")).toEqual(["c"]);
    // An item that starts blank ends at a blank line.
    expect(paragraphs("-\n\n  b")).toEqual(["b"]);
    expect(paragraphs("*\nb")).toEqual(["b"]);
  });

  it("lets only a non-empty item, ordered from 1, interrupt a paragraph", () => {
    expect(paragraphs("a\n1. b")).toEqual(["a"]);
    expect(paragraphs("a\n2. b")).toEqual(["a\n2. b"]);
    expect(paragraphs("a\n*\nb")).toEqual(["a\n*\nb"]);
  });

  it("leaves out leading link reference definitions, never later ones", () => {
    expect(paragraphs("[a]: /u\n[b]: <v> 'title'\ntext")).toEqual(["text"]);
    expect(paragraphs('[a]:\n/u\n"t"\ntext')).toEqual(["text"]);
    expect(paragraphs("[a]: /u")).toEqual([]);
    expect(paragraphs("[a]: /u 'x\ntext")).toEqual(["[a]: /u 'x\ntext"]);
    expect(paragraphs("text\n[a]: /u")).toEqual(["text\n[a]: /u"]);
    // Definitions alone cannot take a setext underline.
    expect(paragraphs("[a]: /u\n===")).toEqual(["==="]);
  });

  it("agrees with micromark where it departs from the reference parser", () => {
    // A list item cannot interrupt indented code.
    expect(paragraphs("    code\n2. b")).toEqual(["2. b"]);
    // Once a line opened a container, it still counts as interrupting.
    expect(paragraphs("a\n> 2. b")).toEqual(["a"]);
    // A complete tag on a lazy line stays inside the quote and ends with it.
    expect(paragraphs("> a\n<x-y>\n> b\nc")).toEqual(["c"]);
    // Indented code begun on a lazy line ends with that line.
    expect(paragraphs("> ```\n    x\n\n2. b")).toEqual([]);
    // A parenthesized title may hold `(`.
    expect(paragraphs("[a]: /u (x(y)\nb")).toEqual(["b"]);
  });
});

describe("captureIntentChain — what it refuses", () => {
  it("refuses a PR that is not open", () => {
    snapshot("ENG-7", "x");
    for (const state of ["MERGED", "CLOSED", ""]) {
      const r = captureIntentChain(base({ state }));
      expect(r.kind).toBe("skipped");
    }
  });

  it("refuses a worktree that is not on the PR's head branch", () => {
    snapshot("ENG-7", "x");
    const r = captureIntentChain(
      base({ checkedOutBranch: "feature/ENG-9-other" }),
    );
    expect(r).toMatchObject({ kind: "skipped" });
    expect((r as { reason: string }).reason).toContain("not PR #42");
    expect(captureIntentChain(base({ checkedOutBranch: "HEAD" })).kind).toBe(
      "skipped",
    );
    expect(captureIntentChain(base({ headRefName: "" })).kind).toBe("skipped");
    expect(() => statSync(pinPath())).toThrow();
  });

  it("refuses a non-numeric PR", () => {
    snapshot("ENG-7", "x");
    expect(captureIntentChain(base({ pr: "../x" })).kind).toBe("skipped");
  });

  it("refuses a missing pickup token despite a mutable snapshot and pointer", () => {
    snapshot("ENG-7", "The mutable source is not pickup evidence.");
    point("ENG-7");
    expect(captureIntentChain(base({ pickupId: undefined })).kind).toBe(
      "skipped",
    );
    expect(() => statSync(pinPath())).toThrow();
  });

  it("refuses a token whose archive does not include the branch-owned item", () => {
    snapshot("ENG-7", "The branch mutable source exists.");
    const unrelated = snapshot("ENG-9", "Another pickup.");
    const r = captureIntentChain(
      base({ pickupId: unrelated, body: "Closes ENG-9" }),
    );
    expect(r.kind).toBe("skipped");
    expect(() => statSync(pinPath())).toThrow();
  });

  it("refuses an archive older than the retention window that no writer pruned", () => {
    const pickupId = snapshot("ENG-7", "An abandoned chain.");
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(join(chainDir(), "pickups", `${pickupId}.json`), old, old);
    const r = captureIntentChain(base({ pickupId }));
    expect(r.kind).toBe("skipped");
    expect((r as { reason: string }).reason).toContain("expired");
    expect(() => statSync(pinPath())).toThrow();
  });

  it("a successful capture restarts the archive retention window", () => {
    const pickupId = snapshot("ENG-7", "The chain.");
    const archive = join(chainDir(), "pickups", `${pickupId}.json`);
    const old = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    utimesSync(archive, old, old);
    expect(captureIntentChain(base({ pickupId })).kind).toBe("captured");
    expect(Date.now() - statSync(archive).mtimeMs).toBeLessThan(60_000);
  });

  it("captures from the archive after the mutable source is removed or replaced", () => {
    const pickupId = snapshot("ENG-7", "The archived chain.");
    rmSync(join(chainDir(), "ENG-7.md"));
    const outside = join(ctx, "outside.txt");
    writeFileSync(outside, "<!-- refocus-arm: on -->\nOTHER CHAIN\n");
    symlinkSync(outside, join(chainDir(), "ENG-7.md"));
    expect(captureIntentChain(base({ pickupId })).kind).toBe("captured");
    expect(readFileSync(pinPath(), "utf8")).toContain("The archived chain.");
    expect(readFileSync(pinPath(), "utf8")).not.toContain("OTHER CHAIN");
  });
});

describe("captureIntentChain — an item-named branch", () => {
  it("copies the branch item's snapshot byte-for-byte into a PR-keyed, owner-only file", () => {
    snapshot("ENG-7", "The chain of ENG-7.");
    const r = captureIntentChain(base());
    expect(r).toMatchObject({
      kind: "captured",
      identifier: "ENG-7",
      via: "branch",
    });
    expect(readFileSync(pinPath(), "utf8")).toBe(
      readFileSync(join(chainDir(), "ENG-7.md"), "utf8"),
    );
    expect(statSync(pinPath()).mode & 0o777).toBe(0o600);
  });

  it("does not consult .current or the PR body when the branch names the item", () => {
    snapshot("ENG-7", "The chain of ENG-7.");
    snapshot("ENG-9", "Someone else.");
    point("ENG-9");
    captureIntentChain(base({ body: "Closes ENG-9" }));
    expect(readFileSync(pinPath(), "utf8")).toContain("The chain of ENG-7.");
  });
});

describe("captureIntentChain — a branch that names no item", () => {
  const noItem = {
    headRefName: "feature/some-slug",
    checkedOutBranch: "feature/some-slug",
  };

  it("captures an archived item when the PR title claims it", () => {
    snapshot("ENG-7", "The chain of ENG-7.");
    point("ENG-7");
    const r = captureIntentChain(
      base({ ...noItem, title: "fix(x): a thing (ENG-7)" }),
    );
    expect(r).toMatchObject({
      kind: "captured",
      identifier: "ENG-7",
      via: "claim",
    });
    expect(readFileSync(pinPath(), "utf8")).toContain("The chain of ENG-7.");
  });

  it("accepts a References/Closes trailer as the claim", () => {
    snapshot("ENG-7", "x");
    point("ENG-7");
    expect(
      captureIntentChain(
        base({ ...noItem, body: "Body.\n\nReferences: ENG-7" }),
      ).kind,
    ).toBe("captured");
  });

  it("refuses when the PR does not claim any identifier in the selected archive", () => {
    snapshot("ENG-9", "A later pickup's chain.");
    point("ENG-9");
    const r = captureIntentChain(
      base({
        ...noItem,
        pickupId: pickups.get("ENG-9"),
        title: "fix(x): a thing (ENG-7)",
        body: "see ENG-9",
      }),
    );
    expect(r.kind).toBe("skipped");
    expect(() => statSync(pinPath())).toThrow();
  });

  it("does not consult an absent or invalid pointer when the archive is claimed", () => {
    snapshot("ENG-7", "x");
    expect(captureIntentChain(base({ ...noItem, title: "ENG-7" })).kind).toBe(
      "captured",
    );
    point("not an identifier");
    expect(
      captureIntentChain(base({ ...noItem, title: "ENG-7", refresh: true }))
        .kind,
    ).toBe("captured");
  });
});

describe("captureIntentChain — first write wins", () => {
  it("keeps an existing pin on a re-arm, even after the source changed", () => {
    snapshot("ENG-7", "The original chain.");
    expect(captureIntentChain(base()).kind).toBe("captured");
    snapshot("ENG-7", "A later solo pickup of the same item.");
    const again = captureIntentChain(base({ pickupId: undefined }));
    expect(again).toMatchObject({ kind: "kept" });
    expect(readFileSync(pinPath(), "utf8")).toContain("The original chain.");
  });

  it("never lets a second non-refresh capture replace a valid pin it lost the race to", () => {
    snapshot("ENG-7", "winner");
    expect(captureIntentChain(base()).kind).toBe("captured");
    // The loser copied a different version, then found the pin already there:
    // creation is exclusive, so the winner stays and no temp file is left.
    snapshot("ENG-7", "loser");
    expect(captureIntentChain(base()).kind).toBe("kept");
    expect(readFileSync(pinPath(), "utf8")).toContain("winner");
    expect(readdirSync(chainDir()).filter((n) => n.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("overwrites only when asked to refresh", () => {
    snapshot("ENG-7", "The original chain.");
    captureIntentChain(base());
    snapshot("ENG-7", "The rewritten chain.");
    expect(captureIntentChain(base({ refresh: true })).kind).toBe("captured");
    expect(readFileSync(pinPath(), "utf8")).toContain("The rewritten chain.");
  });

  it("does not keep a pin without the writer arm line — it re-captures", () => {
    snapshot("ENG-7", "The chain.");
    writeFileSync(pinPath(), "no arm line here\n");
    expect(captureIntentChain(base()).kind).toBe("captured");
    expect(readFileSync(pinPath(), "utf8")).toContain("The chain.");
  });

  it("leaves no repair lock behind after replacing an unrenderable pin", () => {
    snapshot("ENG-7", "The chain.");
    writeFileSync(pinPath(), "no arm line here\n");
    expect(captureIntentChain(base()).kind).toBe("captured");
    expect(readdirSync(chainDir()).filter((n) => n.includes(".tmp-"))).toEqual(
      [],
    );
    expect(existsSync(`${pinPath()}.lock`)).toBe(false);
  });

  it("refuses to repair an unrenderable pin while another holder keeps the lock", () => {
    snapshot("ENG-7", "The chain.");
    writeFileSync(pinPath(), "no arm line here\n");
    writeFileSync(`${pinPath()}.lock`, "");
    const r = captureIntentChain(base());
    expect(r.kind).toBe("skipped");
    expect((r as { reason: string }).reason).toContain("timed out waiting");
    expect(readFileSync(pinPath(), "utf8")).toBe("no arm line here\n");
    expect(readdirSync(chainDir()).filter((n) => n.includes(".tmp-"))).toEqual(
      [],
    );
  });

  it("refresh takes the same lock as repair, so it cannot interleave with one", () => {
    snapshot("ENG-7", "The original chain.");
    captureIntentChain(base());
    snapshot("ENG-7", "The rewritten chain.");
    writeFileSync(`${pinPath()}.lock`, "");
    const r = captureIntentChain(base({ refresh: true }));
    expect(r.kind).toBe("skipped");
    expect((r as { reason: string }).reason).toContain("timed out waiting");
    expect(readFileSync(pinPath(), "utf8")).toContain("The original chain.");
  });

  it("reclaims a lock left by a killed holder", () => {
    snapshot("ENG-7", "The chain.");
    writeFileSync(pinPath(), "no arm line here\n");
    writeFileSync(`${pinPath()}.lock`, "");
    const old = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(`${pinPath()}.lock`, old, old);
    expect(captureIntentChain(base()).kind).toBe("captured");
    expect(existsSync(`${pinPath()}.lock`)).toBe(false);
  });

  it("keeps a pin a concurrent repairer made valid instead of waiting on its lock", () => {
    snapshot("ENG-7", "The chain.");
    writeFileSync(pinPath(), "<!-- refocus-arm: on -->\nwinner\n");
    writeFileSync(`${pinPath()}.lock`, "");
    expect(captureIntentChain(base()).kind).toBe("kept");
    expect(readFileSync(pinPath(), "utf8")).toContain("winner");
  });

  it("a kept pin is refreshed so the writer prune sees it as in use", () => {
    snapshot("ENG-7", "The chain.");
    captureIntentChain(base());
    const old = new Date(Date.now() - 80 * 24 * 60 * 60 * 1000);
    utimesSync(pinPath(), old, old);
    expect(captureIntentChain(base()).kind).toBe("kept");
    expect(Date.now() - statSync(pinPath()).mtimeMs).toBeLessThan(60_000);
  });

  it("an off-arm pin rendered by a drive round is refreshed too", async () => {
    mkdirSync(chainDir(), { recursive: true });
    writeFileSync(pinPath(), "<!-- refocus-arm: off -->\n# chain\n");
    const old = new Date(Date.now() - 80 * 24 * 60 * 60 * 1000);
    utimesSync(pinPath(), old, old);
    await intentChainSection(ctx, undefined, "42");
    expect(Date.now() - statSync(pinPath()).mtimeMs).toBeLessThan(60_000);
  });

  it("does not treat a symlink at the pin path as an existing pin", () => {
    snapshot("ENG-7", "The chain.");
    const outside = join(ctx, "outside.txt");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, pinPath());
    expect(captureIntentChain(base()).kind).toBe("captured");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(readFileSync(pinPath(), "utf8")).toContain("The chain.");
  });
});

describe("late capture retains the original pickup", () => {
  it("pins the original batch archive after a solo pickup overwrites its alias", async () => {
    const pickupId = snapshot("ENG-1", "The BATCH chain (alias).", ["ENG-2"]);
    snapshot("ENG-2", "A later SOLO chain.");
    const armed = captureIntentChain(
      base({
        pickupId,
        headRefName: "feature/ENG-2-batch",
        checkedOutBranch: "feature/ENG-2-batch",
      }),
    );
    expect(armed).toMatchObject({
      kind: "captured",
      identifier: "ENG-2",
      via: "branch",
    });
    const text = (await intentChainSection(ctx, undefined, "42")).join("\n");
    expect(text).toContain("The BATCH chain (alias).");
    expect(text).not.toContain("A later SOLO chain.");
  });

  it("pins the original archive after a same-item pickup overwrites its chain", async () => {
    const pickupId = snapshot("ENG-7", "The original chain of the PR.");
    snapshot("ENG-7", "A later same-item pickup.");
    point("ENG-7");
    expect(captureIntentChain(base({ pickupId })).kind).toBe("captured");
    const text = (await intentChainSection(ctx, undefined, "42")).join("\n");
    expect(text).toContain("The original chain of the PR.");
    expect(text).not.toContain("A later same-item pickup.");
  });

  it("pins a claimed archive after a later pickup moves .current", async () => {
    const pickupId = snapshot("ENG-7", "The chain of the PR.");
    snapshot("ENG-9", "A later pickup.");
    point("ENG-9");
    expect(
      captureIntentChain(
        base({
          pickupId,
          headRefName: "feature/some-slug",
          checkedOutBranch: "feature/some-slug",
          title: "fix(x): a thing (ENG-7)",
        }),
      ).kind,
    ).toBe("captured");
    const text = (await intentChainSection(ctx, undefined, "42")).join("\n");
    expect(text).toContain("The chain of the PR.");
    expect(text).not.toContain("A later pickup.");
  });
});

describe("actual writer pickup identity survives late capture", () => {
  const writer = join(
    import.meta.dir,
    "../../do-issue/scripts/intent-chain.ts",
  );
  const scope = (text: string) => `## Scope\n\n${text}\n`;

  for (const mode of ["batch", "sub-issue"] as const) {
    it(`${mode} token captures original scope after the alias and session copy are overwritten`, async () => {
      expect(Bun.spawnSync(["git", "init", "-q", ctx]).exitCode).toBe(0);
      const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "same-session" };
      const write = (input: Record<string, unknown>) => {
        const inputFile = join(ctx, "input.json");
        writeFileSync(inputFile, JSON.stringify(input));
        const result = Bun.spawnSync(
          [process.execPath, writer, "--input", inputFile],
          {
            cwd: ctx,
            env,
          },
        );
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout.toString()) as {
          pickupId: string;
          path: string;
          sessionPath: string;
        };
      };
      const anchor = {
        identifier: "ENG-1",
        title: "Original anchor scope.",
        description: scope("Original anchor scope."),
      };
      const alias = {
        identifier: "ENG-2",
        title: "Original selected item scope.",
        description: scope("Original selected item scope."),
      };
      const original = write(
        mode === "batch"
          ? { mode: "batch", issue: anchor, items: [anchor, alias] }
          : { issue: anchor, subIssue: alias },
      );
      const originalText = readFileSync(original.path, "utf8");
      const later = write({
        issue: { identifier: "ENG-2", description: scope("Later SOLO scope.") },
      });
      expect(later.pickupId).not.toBe(original.pickupId);
      expect(readFileSync(later.path, "utf8")).toContain("Later SOLO scope.");
      expect(readFileSync(original.sessionPath, "utf8")).toContain(
        "Later SOLO scope.",
      );
      const contextDir = join(ctx, ".context");
      expect(
        captureIntentChain(
          base({
            contextDir,
            pickupId: original.pickupId,
            headRefName: "feature/ENG-2-thing",
            checkedOutBranch: "feature/ENG-2-thing",
          }),
        ).kind,
      ).toBe("captured");
      expect(
        readFileSync(join(contextDir, INTENT_CHAIN_SUBDIR, "pr.42.md"), "utf8"),
      ).toBe(originalText);
      const handoff = (
        await intentChainSection(contextDir, undefined, "42")
      ).join("\n");
      expect(handoff).toContain("Original anchor scope.");
      expect(handoff).toContain("Original selected item scope.");
      expect(handoff).not.toContain("Later SOLO scope.");
    });
  }
});

describe("capture-intent-chain.ts (CLI)", () => {
  const script = join(import.meta.dir, "../scripts/capture-intent-chain.ts");
  const cleanEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // The anchor is stripped by default: a live driver exports it to its
      // passes, and it outranks each case's subprocess cwd. The anchor test
      // sets its own.
      if (v !== undefined && !k.startsWith("GIT_") && k !== "DRIVE_PR_WORKTREE")
        env[k] = v;
    }
    return env;
  };

  /**
   * A scratch repo on `branch` and a `gh` stub answering `pr view --json`. The
   * stub answers from the `.gh-stub.json` in ITS OWN working directory (number
   * projection: `42`) and exits 1 when there is none, so a lookup run from the
   * wrong checkout fails instead of quietly succeeding.
   */
  const scratch = (branch: string, prJson: Record<string, unknown> | null) => {
    const repo = mkdtempSync(join(tmpdir(), "capture-cli-"));
    const env = cleanEnv();
    const sh = (argv: string[]) =>
      expect(Bun.spawnSync(argv, { cwd: repo, env }).exitCode).toBe(0);
    sh(["git", "init", "-q", "."]);
    sh([
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    sh(["git", "checkout", "-q", "-b", branch]);
    const bin = join(repo, "stub-bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        '[ -f "$PWD/.gh-stub.json" ] || exit 1',
        'case "$*" in *"--json number"*) echo 42 ;; *) cat "$PWD/.gh-stub.json" ;; esac',
        "",
      ].join("\n"),
    );
    if (prJson !== null)
      writeFileSync(join(repo, ".gh-stub.json"), JSON.stringify(prJson));
    chmodSync(join(bin, "gh"), 0o755);
    env.PATH = `${bin}:${env.PATH ?? ""}`;
    env.DRIVE_PR_HANDOFF_DIR = join(repo, ".context");
    delete env.DRIVE_PR_INTENT_CHAIN_DIR;
    return { repo, env };
  };

  it("exits 2 on a second positional argument instead of taking the last", () => {
    const r = Bun.spawnSync(["bun", script, "42", "43"], { env: cleanEnv() });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("43");
  });

  it("pins the chain and exits 0 when the PR and the worktree agree", () => {
    const { repo, env } = scratch("feature/ENG-77-thing", {
      state: "OPEN",
      headRefName: "feature/ENG-77-thing",
      title: "t",
      body: "",
    });
    try {
      mkdirSync(join(repo, ".context", INTENT_CHAIN_SUBDIR), {
        recursive: true,
      });
      writeFileSync(
        join(repo, ".context", INTENT_CHAIN_SUBDIR, "ENG-77.md"),
        "<!-- refocus-arm: on -->\n# Intent chain\n\nCLI chain.\n",
      );
      const pickupId = writePickup(
        join(repo, ".context", INTENT_CHAIN_SUBDIR),
        ["ENG-77"],
        "<!-- refocus-arm: on -->\n# Intent chain\n\nCLI chain.\n",
      );
      const r = Bun.spawnSync(
        [process.execPath, script, "42", "--pickup", pickupId],
        {
          cwd: repo,
          env,
        },
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.toString())).toMatchObject({
        kind: "captured",
        identifier: "ENG-77",
      });
      expect(
        readFileSync(
          join(repo, ".context", INTENT_CHAIN_SUBDIR, "pr.42.md"),
          "utf8",
        ),
      ).toContain("CLI chain.");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("exits 3 and writes nothing when the worktree is not the PR's head branch", () => {
    const { repo, env } = scratch("feature/ENG-77-thing", {
      state: "OPEN",
      headRefName: "feature/ENG-88-someone-elses",
      title: "t",
      body: "",
    });
    try {
      mkdirSync(join(repo, ".context", INTENT_CHAIN_SUBDIR), {
        recursive: true,
      });
      const pickupId = writePickup(
        join(repo, ".context", INTENT_CHAIN_SUBDIR),
        ["ENG-88"],
        "<!-- refocus-arm: on -->\nx\n",
      );
      const r = Bun.spawnSync(
        [process.execPath, script, "42", "--pickup", pickupId],
        {
          cwd: repo,
          env,
        },
      );
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain("not pinned");
      expect(() =>
        statSync(join(repo, ".context", INTENT_CHAIN_SUBDIR, "pr.42.md")),
      ).toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("resolves the PR, branch and chain root from $DRIVE_PR_WORKTREE, not the ambient cwd", () => {
    // The driven tree, on the PR's head branch, with its own chain.
    const driven = scratch("feature/ENG-77-thing", {
      state: "OPEN",
      headRefName: "feature/ENG-77-thing",
      title: "t",
      body: "",
    });
    // A different checkout the pass `cd`'d into — same PR stub, other branch
    // and other chain. Reading the branch or the chain root from here would
    // either refuse (branch mismatch) or pin THIS chain into the wrong tree.
    const other = scratch("feature/ENG-99-elsewhere", null);
    try {
      for (const [repo, id, text] of [
        [driven.repo, "ENG-77", "driven chain"],
        [other.repo, "ENG-99", "other chain"],
      ] as const) {
        mkdirSync(join(repo, ".context", INTENT_CHAIN_SUBDIR), {
          recursive: true,
        });
        writeFileSync(
          join(repo, ".context", INTENT_CHAIN_SUBDIR, `${id}.md`),
          `<!-- refocus-arm: on -->\n# Intent chain\n\n${text}.\n`,
        );
      }
      const pickupId = writePickup(
        join(driven.repo, ".context", INTENT_CHAIN_SUBDIR),
        ["ENG-77"],
        "<!-- refocus-arm: on -->\n# Intent chain\n\ndriven chain.\n",
      );
      const env: Record<string, string> = {
        ...driven.env,
        DRIVE_PR_WORKTREE: driven.repo,
      };
      delete env.DRIVE_PR_HANDOFF_DIR;
      // PR omitted: resolvePr runs `gh pr view --json number` and must do so
      // from the driven tree (the other checkout's stub exits 1).
      const r = Bun.spawnSync(
        [process.execPath, script, "--pickup", pickupId],
        {
          cwd: other.repo,
          env,
        },
      );
      expect(r.stderr.toString()).not.toContain("not a PR number");
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.toString())).toMatchObject({
        kind: "captured",
        identifier: "ENG-77",
      });
      expect(
        readFileSync(
          join(driven.repo, ".context", INTENT_CHAIN_SUBDIR, "pr.42.md"),
          "utf8",
        ),
      ).toContain("driven chain.");
      expect(() =>
        statSync(join(other.repo, ".context", INTENT_CHAIN_SUBDIR, "pr.42.md")),
      ).toThrow();
    } finally {
      rmSync(driven.repo, { recursive: true, force: true });
      rmSync(other.repo, { recursive: true, force: true });
    }
  });

  it("exits 1 when the PR cannot be read", () => {
    const { repo, env } = scratch("feature/ENG-77-thing", {});
    try {
      writeFileSync(join(repo, "stub-bin", "gh"), "#!/bin/sh\nexit 1\n");
      const r = Bun.spawnSync([process.execPath, script, "42"], {
        cwd: repo,
        env,
      });
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
