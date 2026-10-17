/**
 * Suite for `/decide`'s mechanical precedent pass.
 *
 * Two kinds of test live here and they are deliberately different in kind:
 *
 *  - **Hermetic unit tests** over a synthetic corpus in a temp dir. These pin
 *    the retrieval mechanics — tokenization, IDF, the candidate noise floor,
 *    the fail-closed empty-corpus refusal, where each source is read from —
 *    without depending on what a real repository happens to contain today.
 *  - **One worked example against THIS repository's corpus** (the last
 *    describe block). It is the acceptance criterion "`already-decided` is
 *    demonstrably reachable" made mechanical: a question this repository
 *    settled in its `AGENTS.md` must surface that policy section first, by a
 *    wide margin. It is intentionally coupled to repository content — if that
 *    stance is ever reworded away, this test SHOULD go red and be re-pointed,
 *    because a precedent pass that stops finding the canonical precedent is
 *    broken in exactly the way no unit test can see.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_PRECEDENT_SOURCES } from "../scripts/lib/overlay.ts";
import {
  BODY_TF_CAP,
  bodyStartIndex,
  type Corpus,
  CorpusError,
  countTerm,
  DEFAULT_TOP,
  documentFrequencies,
  excerptsFor,
  FIELD_WEIGHTS,
  idf,
  isCandidate,
  loadCorpus,
  MIN_DISTINCT_TERMS,
  MIN_TERM_LENGTH,
  main,
  parseArgs,
  parseFrontmatter,
  parseGlossary,
  RARE_DF_MAX,
  renderMarkdown,
  resolvePrecedent,
  scoreDoc,
  splitSections,
  tokenize,
  UNREADABLE_FRONTMATTER_STATUS,
  vocabularyFlags,
} from "../scripts/resolve-precedent.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const REPO_ROOT = resolve(dirname(import.meta.path), "..", "..", "..", "..");
const SCRIPT = join(
  dirname(import.meta.path),
  "..",
  "scripts",
  "resolve-precedent.ts",
);
const FIXED_NOW = new Date("2026-09-15T12:00:00Z");

/** Build a throwaway repo root holding a small, fully known corpus. */
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "decide-fixture-"));
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });

  writeFileSync(
    join(root, "docs", "adr", "ADR-0001-valkey-cache-eviction.md"),
    [
      "---",
      'title: "ADR-0001: Valkey cache eviction policy"',
      "status: approved",
      "tags: [adr, caching]",
      "---",
      "",
      "# ADR-0001: Valkey cache eviction policy",
      "",
      "## Decision",
      "Valkey evicts with allkeys-lru. Backend callers must tolerate a miss.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "docs", "adr", "ADR-0002-backend-logging.md"),
    [
      "---",
      'title: "ADR-0002: Backend logging"',
      "status: superseded",
      "tags: [adr, backend]",
      "---",
      "",
      "# ADR-0002: Backend logging",
      "The backend logs structured JSON. Backend services share one logger.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, "AGENTS.md"),
    [
      // No preamble content before the first `##` here — splitSections'
      // dedicated tests cover that behavior; a blank one keeps this shared
      // fixture's policy-section count pinned at 2 for the many other tests
      // that read it.
      "## Backward Compatibility",
      "Compatibility concerns are deferred until the first release. Do not add compat shims.",
      "",
      "## Outbound request timeouts",
      "Always set a timeout on outbound HTTP calls. Backend workers hang without one.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(root, ".claude", "rules", "git-workflow.md"),
    ["# Git workflow", "Never stash. Branch names start with feature/."].join(
      "\n",
    ),
  );
  // README.md is excluded from the rules corpus by construction.
  writeFileSync(join(root, ".claude", "rules", "README.md"), "# Rules index");

  writeFileSync(
    join(root, "CONTEXT.md"),
    [
      "# Glossary",
      "",
      "**Order**:",
      "A customer's confirmed purchase, ready to be paid and shipped.",
      "_Avoid_: cart, basket, purchase",
      "",
      "**Customer**:",
      "A person or company that places orders in the shop.",
      "_Avoid_: user (a user is anyone who signs in), client, account",
      "",
    ].join("\n"),
  );

  return root;
}

function withFixture<T>(fn: (root: string, corpus: Corpus) => T): T {
  const root = makeFixtureRepo();
  try {
    return fn(root, loadCorpus(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("tokenize", () => {
  it("drops stopwords and short tokens, keeps domain terms", () => {
    const { terms, dropped } = tokenize(
      "Should we use Valkey for the cache or not?",
    );
    expect(terms).toEqual(["valkey", "cache"]);
    expect(dropped).toContain("should");
    expect(dropped).toContain("the");
  });

  it("keeps hyphenated and digit-bearing identifiers whole", () => {
    // These are the highest-precision terms in this corpus; splitting
    // `adr-0039` into `adr` + `0039` would destroy the one term that matches
    // exactly one document.
    const { terms } = tokenize("does ADR-0039 or UUID7 cover ENG-1234");
    expect(terms).toContain("adr-0039");
    expect(terms).toContain("uuid7");
    expect(terms).toContain("eng-1234");
  });

  it("deduplicates repeated terms", () => {
    expect(tokenize("valkey valkey Valkey").terms).toEqual(["valkey"]);
  });

  it(`drops tokens shorter than MIN_TERM_LENGTH (${MIN_TERM_LENGTH})`, () => {
    expect(tokenize("ai ml rls").terms).toEqual(["rls"]);
  });
});

describe("countTerm", () => {
  it("matches whole tokens only", () => {
    // A substring count would score "record" against "recording" and is most
    // of the noise budget at this corpus size.
    expect(countTerm("recording the recordings", "record")).toBe(0);
    expect(countTerm("one record, two records", "record")).toBe(1);
  });

  it("does not split on internal hyphens", () => {
    expect(countTerm("see adr-0039 for this", "adr")).toBe(0);
    expect(countTerm("see adr-0039 for this", "adr-0039")).toBe(1);
  });

  it("treats regex metacharacters in a term as literals", () => {
    expect(countTerm("a c+ b", "c+")).toBe(1);
  });
});

describe("parseFrontmatter", () => {
  it("reads title, status and tags", () => {
    const fm = parseFrontmatter(
      '---\ntitle: "T"\nstatus: approved\ntags: [a, b]\n---\nbody\n',
    );
    expect(fm).toEqual({ title: "T", status: "approved", tags: ["a", "b"] });
  });

  it("flags an invalid YAML block rather than throwing or silently dropping it", () => {
    // One unparseable document must not take the whole corpus down — but the
    // failure must not vanish either, or a deprecated/superseded ADR whose
    // frontmatter breaks would read as having no status at all.
    expect(parseFrontmatter('---\ntitle: "unclosed\n---\nbody')).toEqual({
      frontmatterError: true,
    });
  });

  it("flags a frontmatter block with no closing delimiter at all", () => {
    // Sibling of the case above: the opener is present but there is no
    // closing `---` anywhere. Falling through to the same {} as "no
    // frontmatter block exists" would silently lose whatever
    // status the block would have carried, exactly like the parse-error and
    // non-mapping cases below.
    expect(parseFrontmatter('---\ntitle: "never closed"\nbody\n')).toEqual({
      frontmatterError: true,
    });
  });

  it('does not treat a "----" or "---suffix" decoy line as the closing delimiter', () => {
    // A prefix search for '\n---' matches those too: the decoy would
    // short-circuit the slice right there, so `parseFrontmatter` would return
    // a FALSE SUCCESS — `{title: 'T'}` — silently dropping every line after it
    // (no real closer exists in either fixture) instead of flagging the block
    // as unreadable. Neither decoy satisfies the "complete '---' line" bound,
    // so with no real closer present this falls through to frontmatterError.
    expect(parseFrontmatter('---\ntitle: "T"\n----\nbody')).toEqual({
      frontmatterError: true,
    });
    expect(parseFrontmatter('---\ntitle: "T"\n---suffix\nbody')).toEqual({
      frontmatterError: true,
    });
  });

  it("flags a frontmatter block that parses to a non-mapping value", () => {
    expect(parseFrontmatter("---\njust a scalar\n---\nbody")).toEqual({
      frontmatterError: true,
    });
  });

  it("flags an array root, not just a scalar one", () => {
    // typeof [] === 'object', so a bare object/null check lets an array root
    // through and treats it as a record with every field silently absent.
    expect(parseFrontmatter("---\n- a\n- b\n---\nbody")).toEqual({
      frontmatterError: true,
    });
  });

  it("flags a recognized field present with the wrong type, rather than discarding it", () => {
    // `status: [deprecated]` must not silently become `status: undefined` —
    // indistinguishable from an ADR that never had a status at all, which is
    // exactly the class of bug this whole type exists to prevent.
    expect(parseFrontmatter("---\nstatus: [deprecated]\n---\nbody")).toEqual({
      frontmatterError: true,
    });
    expect(parseFrontmatter("---\ntitle: 123\n---\nbody")).toEqual({
      frontmatterError: true,
    });
    expect(parseFrontmatter('---\ntags: "not-an-array"\n---\nbody')).toEqual({
      frontmatterError: true,
    });
    expect(parseFrontmatter("---\ntags: [a, 1, b]\n---\nbody")).toEqual({
      frontmatterError: true,
    });
  });

  it("returns an empty record when there is no frontmatter, not an error", () => {
    // No frontmatter at all is a legitimate "no lifecycle status recorded",
    // distinct from a parse failure that discarded one.
    expect(parseFrontmatter("# Heading\n")).toEqual({});
  });

  it("returns an empty record when recognized keys are simply absent", () => {
    // A well-formed block that just never sets status/title/tags is not an
    // error either — those keys are legitimately unset, not lost.
    expect(parseFrontmatter("---\nunrelated: value\n---\nbody")).toEqual({
      tags: [],
    });
  });

  it("reads a CRLF-terminated frontmatter block instead of treating it as absent", () => {
    // '---\r\n' never matched the exact '---\n' opener, so a CRLF file's
    // status/title/tags were silently lost — indistinguishable from a doc
    // that genuinely has no frontmatter at all.
    const crlf = '---\r\ntitle: "T"\r\nstatus: approved\r\n---\r\nbody\r\n';
    expect(parseFrontmatter(crlf)).toEqual({
      title: "T",
      status: "approved",
      tags: [],
    });
  });

  it("still flags a CRLF block with no closing delimiter", () => {
    expect(
      parseFrontmatter('---\r\ntitle: "never closed"\r\nbody\r\n'),
    ).toEqual({ frontmatterError: true });
  });
});

describe("splitSections", () => {
  it("splits on level-2 headings and records absolute start lines", () => {
    const content = ["## First", "a", "## Second", "b"].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual(["F § First", "F § Second"]);
    expect(sections[0]?.startLine).toBe(1);
    expect(sections[1]?.startLine).toBe(3);
  });

  it("drops a genuinely blank preamble above the first heading", () => {
    const content = ["", "  ", "## First", "a"].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual(["F § First"]);
  });

  it("captures non-blank content before the first heading as a preamble section", () => {
    // AGENTS.md's own preamble carries real, actionable policy prose before
    // its first `##` — dropping it silently made that content unsearchable
    // even though SKILL.md documents AGENTS.md's policy sections as a
    // searched precedent source.
    const content = [
      "# Doc",
      "Real actionable prose before any heading.",
      "",
      "## First",
      "a",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual(["F (preamble)", "F § First"]);
    expect(sections[0]?.text).toContain("Real actionable prose");
    expect(sections[0]?.startLine).toBe(1);
  });

  it("captures a headingless document as one preamble section rather than dropping it", () => {
    const sections = splitSections("intro only, no headings", "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual(["F (preamble)"]);
    expect(sections[0]?.text).toBe("intro only, no headings");
  });

  it("recognizes a heading with 1-3 leading spaces (legal CommonMark ATX indentation)", () => {
    // A column-zero-only anchor silently merges or drops a legally-indented
    // section instead of failing loudly — and an unparseable input must be
    // an error, never "found nothing".
    const content = [" ## One space", "a", "   ## Three spaces", "b"].join(
      "\n",
    );
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § One space",
      "F § Three spaces",
    ]);
  });

  it("does not treat a 4-space-indented line as a heading (CommonMark: that is a code block)", () => {
    // No REAL heading exists anywhere in this content, so it all becomes one
    // preamble section — the point under test is that the indented line
    // never splits it into two.
    const content = ["# Doc", "    ## Indented code, not a heading", "a"].join(
      "\n",
    );
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual(["F (preamble)"]);
    expect(sections[0]?.text).toContain("Indented code, not a heading");
  });

  it("does not treat a heading-shaped line inside a fenced code block as a real heading", () => {
    // A `## Example` inside a ``` fence read as a real section boundary would
    // truncate the enclosing section and fabricate a fictitious one from the
    // code sample.
    const content = [
      "## Real section",
      "intro",
      "```",
      "## Example",
      "not a heading",
      "```",
      "still inside Real section",
      "## Next real section",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Next real section",
    ]);
    expect(sections[0]?.text).toContain("## Example");
    expect(sections[0]?.text).toContain("still inside Real section");
  });

  it("does not close a fence on a differently-styled or shorter delimiter line", () => {
    // A fence toggled on ANY fence-shaped line, regardless of character or
    // run length, would let a `~~~` line (or a shorter run of the same
    // character) inside an OPEN fence close it early, and a heading-shaped
    // line still inside the sample would read as real.
    const content = [
      "## Real section",
      "````",
      "~~~",
      "## Example",
      "```",
      "still fenced content",
      "````",
      "## Next real section",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Next real section",
    ]);
    expect(sections[0]?.text).toContain("## Example");
    expect(sections[0]?.text).toContain("still fenced content");
  });

  it("does not open a fence on a backtick run whose info string itself contains a backtick", () => {
    // CommonMark forbids a backtick inside a BACKTICK
    // fence's own info string (ambiguous with an inline code span), so a
    // line like ```lang`variant is not a real fence opener at all — leave
    // it as ordinary text so a real heading right after it is still found.
    const content = [
      "## Real section",
      "intro",
      "```lang`variant",
      "## Still a real heading",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Still a real heading",
    ]);
    expect(sections[0]?.text).toContain("```lang`variant");
    expect(sections[1]?.text).toContain("b");
  });

  it("still opens a tilde fence whose info string contains a backtick", () => {
    // That restriction is backtick-specific — CommonMark places no
    // such restriction on a tilde fence's info string.
    const content = [
      "## Real section",
      "~~~lang`variant",
      "## Example",
      "still fenced content",
      "~~~",
      "## Next real section",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Next real section",
    ]);
    expect(sections[0]?.text).toContain("## Example");
    expect(sections[0]?.text).toContain("still fenced content");
  });

  it("does not close a fence on a matching-run line carrying an info string", () => {
    // CommonMark forbids an info string on a CLOSING fence
    // — only an opener may carry one — so a same-character,
    // equal-or-longer run followed by anything but whitespace (a nested
    // ```typescript example line, say, matching the outer 3-backtick
    // opener's own length) does not close the block.
    const content = [
      "## Real section",
      "```",
      "Example of a nested code sample:",
      "```typescript",
      "## Example",
      "still fenced content",
      "```",
      "## Next real section",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Next real section",
    ]);
    expect(sections[0]?.text).toContain("## Example");
    expect(sections[0]?.text).toContain("still fenced content");
  });

  it("does not read a YAML frontmatter block as a Setext-heading section", () => {
    // A frontmatter `title:` line immediately followed by the closing `---`
    // delimiter is a real CommonMark Setext-heading underline — this is the
    // hazard `remark-parse` introduced by construction once it replaced the
    // ATX-only hand-rolled recognizer, so `splitSections` must strip the
    // frontmatter block before parsing (it does, via `bodyStartIndex`) or
    // every document this corpus loads unstripped (`loadPolicy` passes
    // AGENTS.md whole) would fabricate a phantom section straight out of its
    // own metadata.
    const content = [
      "---",
      'title: "Not a heading"',
      "status: approved",
      "---",
      "",
      "## Real section",
      "body",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F (preamble)",
      "F § Real section",
    ]);
    expect(sections[0]?.text).toContain('title: "Not a heading"');
    expect(sections[1]?.text).toBe("## Real section\nbody");
  });

  it("recognizes a Setext (underlined) heading as a real section boundary", () => {
    // A real CommonMark parser recognizes underlined headings the old ATX-only
    // regex never did at all — not a regression fix, a capability the
    // hand-rolled recognizer never had.
    const content = [
      "Real section",
      "------------",
      "",
      "body",
      "",
      "Next real section",
      "-----------------",
      "",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Next real section",
    ]);
  });

  it("does not fabricate a heading from a frontmatter block that opens but never closes", () => {
    // The opener matches but the only candidate closer is '----' (four
    // dashes, not an exact '---'), so the block never closes. Falling
    // through to "no frontmatter" would hand this raw text to
    // collectBodyHeadings as ordinary body: CommonMark reads
    // 'status: approved' immediately followed by '----' as a real Setext
    // heading, fabricating a section straight out of unparseable metadata.
    // bodyStartIndex skips the whole document instead, so nothing here
    // — including the genuine-looking '## Real section' further down —
    // splits into its own section; it all lands in one preamble bucket.
    const content = [
      "---",
      "status: approved",
      "----",
      "",
      "## Real section",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual(["F (preamble)"]);
    expect(sections[0]?.text).toBe(content);
  });

  it('labels a genuine but textless "##" heading as untitled, not as the preamble', () => {
    // A bare '##' (or '## ##') is a valid CommonMark level-2 heading whose
    // rendered text is the empty string — a real section boundary, not the
    // absence of one. Truthiness-testing the heading text would fold this
    // into the preamble bucket, producing a false structural citation.
    const content = ["## First", "a", "##", "b"].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § First",
      "F § (untitled)",
    ]);
    expect(sections[1]?.text).toBe("##\nb");
  });

  it("flags every emitted section when the caller reports a frontmatter parse failure", () => {
    // splitSections has no per-doc status field of its own to silently drop
    // — the caller (loadPolicy) is
    // responsible for parsing frontmatter and passing the verdict in, and
    // this only proves the flag actually reaches every section produced.
    const content = ["## First", "a", "## Second", "b"].join("\n");
    const sections = splitSections(content, "F.md", "F", true);
    expect(sections.map((s) => s.status)).toEqual([
      UNREADABLE_FRONTMATTER_STATUS,
      UNREADABLE_FRONTMATTER_STATUS,
    ]);
  });

  it("leaves status unset when no frontmatter error is reported", () => {
    const sections = splitSections("## First\na", "F.md", "F");
    expect(sections[0]?.status).toBeUndefined();
  });
});

describe("splitSections on the CommonMark grammar", () => {
  it("starts a multi-line Setext heading on its first line", () => {
    const content = [
      "intro",
      "",
      "A heading that",
      "spans two lines",
      "---------------",
      "body",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F (preamble)",
      "F § A heading that\nspans two lines",
    ]);
    expect(sections[1]?.startLine).toBe(3);
  });

  it("does not split on a heading inside a block quote or a list item", () => {
    const content = [
      "## Real section",
      "> ## Quoted",
      "",
      "- item",
      "",
      "  ## Inside the item",
      "",
      "## Next real section",
      "b",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => s.title)).toEqual([
      "F § Real section",
      "F § Next real section",
    ]);
    expect(sections[1]?.startLine).toBe(8);
  });

  it("keeps the start line of every heading after a long fenced block", () => {
    const fence = Array.from({ length: 40 }, (_, i) => `## fenced ${i}`);
    const content = [
      "## One",
      "```",
      ...fence,
      "```",
      "## Two",
      "Setext",
      "======",
    ].join("\n");
    const sections = splitSections(content, "F.md", "F");
    expect(sections.map((s) => [s.title, s.startLine])).toEqual([
      ["F § One", 1],
      ["F § Two", 44],
    ]);
    // `Setext` is a level-1 heading: it does not start a `##` section.
    expect(sections[1]?.text).toContain("Setext");
  });
});

describe("where the sources are read from", () => {
  function repoWithCustomLayout(): string {
    const root = mkdtempSync(join(tmpdir(), "decide-sources-"));
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    writeFileSync(
      join(root, "docs", "decisions", "ADR-0003-queue-retries.md"),
      "# ADR-0003: Queue retries\nJobs retry three times with backoff.\n",
    );
    writeFileSync(
      join(root, "CLAUDE.md"),
      "## Retries\nNever retry a payment capture.\n",
    );
    writeFileSync(
      join(root, ".cursor", "rules", "jobs.md"),
      "# Jobs\nEvery job is idempotent.\n",
    );
    writeFileSync(
      join(root, "GLOSSARY.md"),
      "**Job**:\nA unit of background work.\n_Avoid_: task\n",
    );
    return root;
  }

  it("uses the defaults when the repository configures nothing", () => {
    expect(DEFAULT_PRECEDENT_SOURCES).toEqual({
      adrDirectory: "docs/adr",
      policyFiles: ["AGENTS.md"],
      rulesDirectory: ".claude/rules",
      glossaryFile: "CONTEXT.md",
    });
  });

  it("reads every source from the paths it is given", () => {
    const root = repoWithCustomLayout();
    try {
      const corpus = loadCorpus(root, {
        adrDirectory: "docs/decisions",
        policyFiles: ["CLAUDE.md"],
        rulesDirectory: ".cursor/rules",
        glossaryFile: "GLOSSARY.md",
      });
      expect(corpus.docs.map((d) => [d.kind, d.file])).toEqual([
        ["adr", "docs/decisions/ADR-0003-queue-retries.md"],
        ["policy", "CLAUDE.md"],
        ["rule", ".cursor/rules/jobs.md"],
      ]);
      expect(corpus.glossary.map((g) => g.term)).toEqual(["Job"]);
      expect(corpus.glossaryFile).toBe("GLOSSARY.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the paths from the repository's Jig configuration", () => {
    const root = repoWithCustomLayout();
    const saved = process.env.JIG_OVERLAY;
    delete process.env.JIG_OVERLAY;
    try {
      mkdirSync(join(root, ".config"));
      writeFileSync(
        join(root, ".config", "jig.yaml"),
        [
          "adr:",
          "  directory: docs/decisions",
          "decide:",
          "  policy_files: [CLAUDE.md]",
          "  rules_directory: .cursor/rules",
          "  glossary_file: GLOSSARY.md",
          "",
        ].join("\n"),
      );
      const report = resolvePrecedent({
        repoRoot: root,
        query: "payment capture retry",
        now: FIXED_NOW,
      });
      expect(report.sources.adrDirectory).toBe("docs/decisions");
      expect(report.corpus).toEqual({
        adr: 1,
        policy: 1,
        rule: 1,
        glossaryTerms: 1,
      });
      expect(report.incompleteSources).toEqual([]);
      expect(renderMarkdown(report)).toContain(
        "**Sources**: docs/decisions/, CLAUDE.md, .cursor/rules/, GLOSSARY.md",
      );
    } finally {
      if (saved === undefined) delete process.env.JIG_OVERLAY;
      else process.env.JIG_OVERLAY = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a configured path outside the repository, and exits 2 on it", () => {
    const root = repoWithCustomLayout();
    const saved = process.env.JIG_OVERLAY;
    const overlay = join(root, "overlay.yaml");
    writeFileSync(overlay, "adr:\n  directory: ../elsewhere\n");
    process.env.JIG_OVERLAY = overlay;
    const origErr = console.error;
    const errors: string[] = [];
    console.error = (msg: string) => errors.push(msg);
    try {
      expect(() => loadCorpus(root)).toThrow(
        "adr.directory must be a path inside the repository",
      );
      expect(main(["retry", "--repo-root", root], root, FIXED_NOW)).toBe(2);
      expect(errors.join("\n")).toContain("adr.directory");
    } finally {
      console.error = origErr;
      if (saved === undefined) delete process.env.JIG_OVERLAY;
      else process.env.JIG_OVERLAY = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseGlossary", () => {
  it("pairs each term with its Avoid aliases and strips parentheticals", () => {
    const entries = parseGlossary(
      [
        "**Record**:",
        "text",
        "_Avoid_: document (a document is the artifact), item",
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.term).toBe("Record");
    expect(entries[0]?.avoid).toEqual(["document", "item"]);
    expect(entries[0]?.canonicalLine).toBe(1);
  });

  it("leaves a term with no Avoid line with an empty alias list", () => {
    expect(parseGlossary("**Solo**:\njust prose\n")[0]?.avoid).toEqual([]);
  });
});

describe("loadCorpus", () => {
  it("loads ADRs, policy sections, rules and glossary", () => {
    withFixture((_root, corpus) => {
      expect(corpus.docs.filter((d) => d.kind === "adr")).toHaveLength(2);
      expect(corpus.docs.filter((d) => d.kind === "policy")).toHaveLength(2);
      expect(corpus.docs.filter((d) => d.kind === "rule")).toHaveLength(1);
      expect(corpus.glossary).toHaveLength(2);
    });
  });

  it("excludes the rules README from the corpus", () => {
    withFixture((_root, corpus) => {
      expect(corpus.docs.map((d) => d.file)).not.toContain(
        join(".claude", "rules", "README.md"),
      );
    });
  });

  it("throws CorpusError rather than reporting an unearned null result", () => {
    // The whole value of a `no-precedent` verdict is that the corpus was
    // really searched. An empty corpus would produce the same verdict from a
    // wrong --repo-root, so it must fail closed instead.
    const empty = mkdtempSync(join(tmpdir(), "decide-empty-"));
    try {
      expect(() => loadCorpus(empty)).toThrow(CorpusError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("throws CorpusError when only the glossary is non-empty", () => {
    // The glossary is excluded from scoring (vocabularyFlags reads it, no
    // candidate is ever built from it) — a checkout with CONTEXT.md but no
    // ADRs/policy/rules has zero searchable documents and must fail closed
    // exactly like a fully empty one, not manufacture zero-hit evidence from
    // a corpus that was never actually searchable.
    const glossaryOnly = mkdtempSync(join(tmpdir(), "decide-glossary-only-"));
    try {
      writeFileSync(
        join(glossaryOnly, "CONTEXT.md"),
        ["# Glossary", "", "**Record**:", "A tracked entry.", ""].join("\n"),
      );
      expect(() => loadCorpus(glossaryOnly)).toThrow(CorpusError);
    } finally {
      rmSync(glossaryOnly, { recursive: true, force: true });
    }
  });

  it("surfaces an ADR whose frontmatter failed to parse rather than indexing it as statusless", () => {
    // A silently discarded status could make a deprecated or superseded ADR
    // look like an unqualified precedent candidate — it must be visibly
    // flagged instead of blending in with a genuinely status-free doc.
    const root = mkdtempSync(join(tmpdir(), "decide-badfrontmatter-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(
        join(root, "docs", "adr", "ADR-0099-broken.md"),
        ["---", 'title: "unclosed', "---", "# ADR-0099: Broken", ""].join("\n"),
      );
      const corpus = loadCorpus(root);
      const doc = corpus.docs.find((d) => d.file.includes("ADR-0099"));
      expect(doc?.status).toBe(UNREADABLE_FRONTMATTER_STATUS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces an AGENTS.md policy section whose frontmatter failed to parse", () => {
    // Same failure shape as the ADR case above, on the loadPolicy/splitSections
    // path: an unclosed frontmatter block must not fall into the preamble
    // section as ordinary text with no status caveat at all — ranked and
    // citable with no indication its own metadata was unreadable.
    const root = mkdtempSync(join(tmpdir(), "decide-policy-badfrontmatter-"));
    try {
      writeFileSync(
        join(root, "AGENTS.md"),
        ["---", 'title: "unclosed', "---", "## A Section", "body", ""].join(
          "\n",
        ),
      );
      const corpus = loadCorpus(root);
      const doc = corpus.docs.find((d) => d.kind === "policy");
      expect(doc?.status).toBe(UNREADABLE_FRONTMATTER_STATUS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a rule whose frontmatter failed to parse", () => {
    const root = mkdtempSync(join(tmpdir(), "decide-rule-badfrontmatter-"));
    try {
      mkdirSync(join(root, ".claude", "rules"), { recursive: true });
      writeFileSync(
        join(root, ".claude", "rules", "broken.md"),
        ["---", 'title: "unclosed', "---", "# Broken Rule", ""].join("\n"),
      );
      const corpus = loadCorpus(root);
      const doc = corpus.docs.find((d) => d.kind === "rule");
      expect(doc?.status).toBe(UNREADABLE_FRONTMATTER_STATUS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to an indented level-1 heading for the title", () => {
    // A title heading indented 1-3 spaces is still a level-1 heading; it must
    // not fall through to the filename.
    const root = mkdtempSync(join(tmpdir(), "decide-heading-fallback-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(
        join(root, "docs", "adr", "ADR-0098-indented-title.md"),
        [" # Indented Title", "body text", ""].join("\n"),
      );
      const corpus = loadCorpus(root);
      const doc = corpus.docs.find((d) => d.file.includes("ADR-0098"));
      expect(doc?.title).toBe("Indented Title");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to a heading-shaped line inside a fenced code block", () => {
    const root = mkdtempSync(join(tmpdir(), "decide-heading-fence-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(
        join(root, "docs", "adr", "ADR-0097-fenced-title.md"),
        [
          "```",
          "# Not a real heading",
          "```",
          "# Real Title",
          "body text",
          "",
        ].join("\n"),
      );
      const corpus = loadCorpus(root);
      const doc = corpus.docs.find((d) => d.file.includes("ADR-0097"));
      expect(doc?.title).toBe("Real Title");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to a title-shaped line fabricated from frontmatter", () => {
    // A frontmatter block with no `title:` key falls through to `firstHeading`
    // — which must skip the frontmatter block itself, or the `status:` line
    // right above the closing `---` reads as a Setext-heading underline and
    // fabricates a bogus title straight out of the document's own metadata.
    const root = mkdtempSync(join(tmpdir(), "decide-heading-frontmatter-"));
    try {
      mkdirSync(join(root, "docs", "adr"), { recursive: true });
      writeFileSync(
        join(root, "docs", "adr", "ADR-0099-no-title-key.md"),
        [
          "---",
          "status: approved",
          "---",
          "",
          "# Real Title",
          "body text",
          "",
        ].join("\n"),
      );
      const corpus = loadCorpus(root);
      const doc = corpus.docs.find((d) => d.file.includes("ADR-0099"));
      expect(doc?.title).toBe("Real Title");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scoring", () => {
  it("weights a title hit above a body hit", () => {
    withFixture((_root, corpus) => {
      const docs = corpus.docs;
      const df = documentFrequencies(docs, ["valkey"]);
      const inTitle = docs.find((d) => d.title.includes("Valkey"));
      if (!inTitle) throw new Error("fixture lost its titled ADR");
      const scored = scoreDoc(inTitle, ["valkey"], df, docs.length);
      // title (5) + tag (0) + heading (2 capped) + body (3 capped) — the point
      // is only that the title multiplier is the dominant contributor.
      expect(FIELD_WEIGHTS.title).toBeGreaterThan(FIELD_WEIGHTS.body);
      expect(scored.score).toBeGreaterThan(0);
      expect(scored.matchedTerms).toEqual(["valkey"]);
    });
  });

  it("gives a rare term more weight than a ubiquitous one", () => {
    expect(idf(100, 1)).toBeGreaterThan(idf(100, 90));
  });

  it("caps body term frequency so one repetitive document cannot dominate", () => {
    const doc = {
      kind: "adr" as const,
      file: "f.md",
      startLine: 1,
      title: "unrelated",
      tags: [],
      text: Array(50).fill("cache").join(" "),
    };
    const df = new Map([["cache", 1]]);
    const capped = scoreDoc(doc, ["cache"], df, 10);
    const expectedMax = idf(10, 1) * FIELD_WEIGHTS.body * BODY_TF_CAP;
    expect(capped.score).toBeLessThanOrEqual(expectedMax + 1e-9);
  });

  it("does not award heading-field weight to a heading-shaped line inside a fenced code block", () => {
    // Sibling of the splitSections fence case: a `## term` inside a ```
    // sample must not get the same scoring boost as a real heading.
    const df = new Map([["uniqueterm", 1]]);
    const fenced = scoreDoc(
      {
        kind: "adr",
        file: "f.md",
        startLine: 1,
        title: "unrelated",
        tags: [],
        text: ["intro", "```", "## uniqueterm", "```", "body text"].join("\n"),
      },
      ["uniqueterm"],
      df,
      10,
    );
    const real = scoreDoc(
      {
        kind: "adr",
        file: "f.md",
        startLine: 1,
        title: "unrelated",
        tags: [],
        text: ["intro", "## uniqueterm", "body text"].join("\n"),
      },
      ["uniqueterm"],
      df,
      10,
    );
    // Both hit the term in the body (identical bodyHits); only the real
    // heading also earns the heading-field weight, so it must score higher.
    expect(fenced.score).toBeLessThan(real.score);
  });
});

describe("isCandidate (the noise floor)", () => {
  const df = new Map([
    ["backend", 80],
    ["valkey", 2],
  ]);

  it("rejects a single ubiquitous-term match", () => {
    expect(isCandidate(["backend"], df)).toBe(false);
  });

  it(`accepts ${MIN_DISTINCT_TERMS} distinct terms`, () => {
    expect(isCandidate(["backend", "valkey"], df)).toBe(true);
  });

  it(`accepts one term rare enough (df <= ${RARE_DF_MAX}) to stand alone`, () => {
    expect(isCandidate(["valkey"], df)).toBe(true);
  });
});

describe("excerpts", () => {
  it("skips the frontmatter block", () => {
    expect(bodyStartIndex(["---", "title: x", "---", "body"])).toBe(3);
    expect(bodyStartIndex(["# no frontmatter"])).toBe(0);
  });

  it("skips a CRLF-sourced frontmatter block instead of citing its raw YAML as evidence", () => {
    // doc.text keeps the ORIGINAL content — parseFrontmatter normalizes CRLF
    // only for its own delimiter detection — so a CRLF ADR's lines still
    // carry a trailing '\r' here. An exact '---' match missed the block
    // entirely and let excerptsFor cite 'title:'/'status:' lines as if they
    // were substantive policy text.
    expect(bodyStartIndex(["---\r", "title: x\r", "---\r", "body\r"])).toBe(3);
  });

  it("skips the WHOLE document when the frontmatter opens but never closes", () => {
    // No line here is an exact '---' after the opener, so the closing search
    // exhausts the array. This must not fall through to the "no frontmatter"
    // return of 0 — that would let a decoy like 'status: approved' immediately
    // followed by '----' be read as body text, where CommonMark parses it as
    // a real Setext heading. With no reliable boundary to skip TO, skip
    // everything instead.
    const lines = ["---", "status: approved", "----", "body"];
    expect(bodyStartIndex(lines)).toBe(lines.length);
  });

  it("cites absolute line numbers inside the source file", () => {
    const content = ["## First", "valkey lives here"].join("\n");
    const [section] = splitSections(content, "F.md", "F");
    if (!section) throw new Error("no section");
    const [excerpt] = excerptsFor(section, ["valkey"]);
    expect(excerpt?.line).toBe(2);
    expect(excerpt?.text).toBe("valkey lives here");
  });

  it("never cites a CRLF document’s raw frontmatter as excerpt evidence", () => {
    const doc = {
      kind: "adr" as const,
      file: "f.md",
      startLine: 1,
      title: "unrelated",
      status: "valkey", // present only in frontmatter, never in the real body
      tags: [],
      text: ["---\r", "title: x\r", "status: valkey\r", "---\r", "body\r"].join(
        "\n",
      ),
    };
    expect(excerptsFor(doc, ["valkey"])).toEqual([]);
  });
});

describe("vocabularyFlags", () => {
  it("flags an Avoid alias and names the canonical term", () => {
    withFixture((_root, corpus) => {
      const flags = vocabularyFlags(
        "how should a cart become paid",
        corpus.glossary,
        "CONTEXT.md",
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({
        used: "cart",
        canonical: "Order",
      });
    });
  });

  it("stays silent when the canonical vocabulary is already used", () => {
    withFixture((_root, corpus) => {
      expect(
        vocabularyFlags("order shipping", corpus.glossary, "CONTEXT.md"),
      ).toEqual([]);
    });
  });
});

describe("resolvePrecedent", () => {
  it("surfaces the matching ADR first", () => {
    withFixture((root, corpus) => {
      const report = resolvePrecedent({
        repoRoot: root,
        query: "what is our valkey cache eviction policy",
        now: FIXED_NOW,
        corpus,
      });
      expect(report.verdict).toBe("precedent-candidates");
      expect(report.candidates[0]?.file).toContain("ADR-0001");
      expect(report.candidates[0]?.status).toBe("approved");
    });
  });

  it("reports no-precedent WITH the corpus it searched", () => {
    // This is the zero-hit evidence a ruling rests on. A bare "nothing found"
    // is not citable; the counts and the term list are what make it so.
    withFixture((root, corpus) => {
      const report = resolvePrecedent({
        repoRoot: root,
        query: "kubernetes sidecar mutating webhook admission ordering",
        now: FIXED_NOW,
        corpus,
      });
      expect(report.verdict).toBe("no-precedent");
      expect(report.candidates).toEqual([]);
      expect(report.corpus.adr).toBe(2);
      expect(report.corpus.policy).toBe(2);
      expect(report.corpus.glossaryTerms).toBe(2);
      expect(report.terms.length).toBeGreaterThan(0);
      expect(report.searchedAt).toBe("2026-09-15");
    });
  });

  it("finds a policy section, not just ADRs", () => {
    withFixture((root, corpus) => {
      const report = resolvePrecedent({
        repoRoot: root,
        query: "is a backward compatibility compat shim acceptable",
        now: FIXED_NOW,
        corpus,
      });
      expect(report.candidates[0]?.file).toBe("AGENTS.md");
      expect(report.candidates[0]?.title).toContain("Backward Compatibility");
    });
  });

  it("honours --top", () => {
    withFixture((root, corpus) => {
      const report = resolvePrecedent({
        repoRoot: root,
        query: "backend logging and backend cache and outbound timeout",
        top: 1,
        now: FIXED_NOW,
        corpus,
      });
      expect(report.candidates.length).toBeLessThanOrEqual(1);
    });
  });

  it("returns no-searchable-terms when the query is all stopwords, never no-precedent", () => {
    // terms.length === 0 means nothing was ever searched — that must not be
    // reported as the zero-hit evidence 'no-precedent' promises.
    withFixture((root, corpus) => {
      const report = resolvePrecedent({
        repoRoot: root,
        query: "should we do this or that",
        now: FIXED_NOW,
        corpus,
      });
      expect(report.terms).toEqual([]);
      expect(report.verdict).toBe("no-searchable-terms");
      expect(report.candidates).toEqual([]);
    });
  });

  it("flags incompleteSources when a doc-bearing category is entirely empty but others are not", () => {
    // loadCorpus's own empty-check only refuses when EVERY doc-bearing
    // category is empty at once — a sparse/mispointed --repo-root missing
    // just one of them (e.g. no .claude/rules/) still passes it and can
    // manufacture a confident no-precedent from a corpus that only ever
    // searched a subset of what it claims.
    const corpus: Corpus = {
      docs: [
        {
          kind: "adr",
          file: "docs/adr/ADR-0001-valkey.md",
          startLine: 1,
          title: "ADR-0001: Valkey cache eviction",
          status: "approved",
          tags: [],
          text: "Valkey evicts with allkeys-lru.",
        },
      ],
      // Non-empty on purpose — this test isolates the doc-bearing-category
      // dimension; the sibling glossary case is covered separately below.
      glossary: [{ term: "Order", canonicalLine: 1, avoid: [] }],
      glossaryFile: "CONTEXT.md",
      sources: DEFAULT_PRECEDENT_SOURCES,
    };
    const report = resolvePrecedent({
      repoRoot: "/unused",
      query: "valkey cache eviction",
      now: FIXED_NOW,
      corpus,
    });
    expect(report.incompleteSources).toEqual(["policy", "rule"]);
  });

  it("flags incompleteSources when the glossary is empty, even with a complete doc-bearing corpus", () => {
    // A missing/unreadable CONTEXT.md never trips docs.length === 0 (the
    // glossary isn't part of docs), so without dedicated tracking a
    // mispointed --repo-root could silently skip vocabulary/_Avoid_-alias
    // enforcement while the corpus otherwise reads as complete.
    withFixture((root, corpus) => {
      const glossaryFreeCorpus: Corpus = { ...corpus, glossary: [] };
      const report = resolvePrecedent({
        repoRoot: root,
        query: "valkey cache eviction",
        now: FIXED_NOW,
        corpus: glossaryFreeCorpus,
      });
      expect(report.incompleteSources).toEqual(["glossary"]);
    });
  });

  it("reports no incompleteSources when every doc-bearing category has at least one document", () => {
    withFixture((root, corpus) => {
      const report = resolvePrecedent({
        repoRoot: root,
        query: "valkey cache eviction",
        now: FIXED_NOW,
        corpus,
      });
      expect(report.incompleteSources).toEqual([]);
    });
  });
});

describe("renderMarkdown", () => {
  it("states the verdict, the corpus and citable file:line evidence", () => {
    withFixture((root, corpus) => {
      const md = renderMarkdown(
        resolvePrecedent({
          repoRoot: root,
          query: "valkey cache eviction",
          now: FIXED_NOW,
          corpus,
        }),
      );
      expect(md).toContain("precedent-candidates");
      expect(md).toContain("ADR-0001-valkey-cache-eviction.md:");
      expect(md).toContain("it does not rule");
    });
  });

  it("spells out that a null result is evidence, not an absence of search", () => {
    withFixture((root, corpus) => {
      const md = renderMarkdown(
        resolvePrecedent({
          repoRoot: root,
          query: "kubernetes sidecar mutating webhook admission",
          now: FIXED_NOW,
          corpus,
        }),
      );
      expect(md).toContain("no-precedent");
      expect(md).toContain("zero-hit evidence");
      expect(md).toContain("2 ADRs");
    });
  });

  it("tells a degenerate query apart from a real zero-hit search", () => {
    withFixture((root, corpus) => {
      const md = renderMarkdown(
        resolvePrecedent({
          repoRoot: root,
          query: "should we do this or that",
          now: FIXED_NOW,
          corpus,
        }),
      );
      expect(md).toContain("no-searchable-terms");
      expect(md).toContain("NOT zero-hit evidence");
      expect(md).not.toContain("nothing in the corpus above the noise floor");
    });
  });

  it("warns when the corpus is a subset, not full coverage", () => {
    const corpus: Corpus = {
      docs: [
        {
          kind: "adr",
          file: "docs/adr/ADR-0001-valkey.md",
          startLine: 1,
          title: "ADR-0001: Valkey cache eviction",
          status: "approved",
          tags: [],
          text: "Valkey evicts with allkeys-lru.",
        },
      ],
      glossary: [{ term: "Order", canonicalLine: 1, avoid: [] }],
      glossaryFile: "CONTEXT.md",
      sources: DEFAULT_PRECEDENT_SOURCES,
    };
    const md = renderMarkdown(
      resolvePrecedent({
        repoRoot: "/unused",
        query: "valkey cache eviction",
        now: FIXED_NOW,
        corpus,
      }),
    );
    expect(md).toContain("policy, rule came back empty");
    expect(md).toContain("this corpus is a subset, not full coverage");
  });

  it('never calls a degraded no-precedent result "explicit zero-hit evidence"', () => {
    // A warning line alone is not enough: the verdict text must not call
    // this citable zero-hit evidence when policy/rule were never searched at
    // all. A query that misses the one
    // present ADR must land on this non-citable branch, not the ordinary
    // no-precedent one.
    const corpus: Corpus = {
      docs: [
        {
          kind: "adr",
          file: "docs/adr/ADR-0001-valkey.md",
          startLine: 1,
          title: "ADR-0001: Valkey cache eviction",
          status: "approved",
          tags: [],
          text: "Valkey evicts with allkeys-lru.",
        },
      ],
      glossary: [{ term: "Order", canonicalLine: 1, avoid: [] }],
      glossaryFile: "CONTEXT.md",
      sources: DEFAULT_PRECEDENT_SOURCES,
    };
    const report = resolvePrecedent({
      repoRoot: "/unused",
      query: "kubernetes sidecar mutating webhook",
      now: FIXED_NOW,
      corpus,
    });
    expect(report.verdict).toBe("no-precedent");
    expect(report.incompleteSources).toEqual(["policy", "rule"]);
    const md = renderMarkdown(report);
    expect(md).toContain("corpus above is INCOMPLETE");
    expect(md).toContain("NOT the explicit zero-hit evidence");
    expect(md).not.toContain(
      "nothing in the corpus above the noise floor. This is the explicit",
    );
  });

  it("stays silent about incompleteSources when the corpus is not degraded", () => {
    withFixture((root, corpus) => {
      const md = renderMarkdown(
        resolvePrecedent({
          repoRoot: root,
          query: "valkey cache eviction",
          now: FIXED_NOW,
          corpus,
        }),
      );
      expect(md).not.toContain("came back empty");
    });
  });
});

describe("parseArgs", () => {
  it("joins positional words into the query and defaults the rest", () => {
    const args = parseArgs(["valkey", "eviction"], "/repo");
    expect(args).toEqual({
      query: "valkey eviction",
      top: DEFAULT_TOP,
      json: false,
      repoRoot: "/repo",
    });
  });

  it("rejects a non-positive --top", () => {
    expect(() => parseArgs(["q", "--top", "0"], "/repo")).toThrow(/positive/);
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    expect(() => parseArgs(["q", "--deep"], "/repo")).toThrow(/unknown flag/);
  });

  it("rejects an empty query", () => {
    expect(() => parseArgs(["--json"], "/repo")).toThrow(/usage/);
  });

  it("rejects --repo-root followed by another flag rather than consuming it as the directory", () => {
    // `!value` alone only catches a MISSING value — `--repo-root --json`
    // silently set repoRoot to the literal string '--json' and swallowed
    // the real --json flag, searching the wrong root instead of refusing.
    expect(() => parseArgs(["q", "--repo-root", "--json"], "/repo")).toThrow(
      /--repo-root expects a directory/,
    );
  });

  it("still accepts a legitimate --repo-root value", () => {
    const args = parseArgs(["q", "--repo-root", "/elsewhere"], "/repo");
    expect(args.repoRoot).toBe("/elsewhere");
  });
});

describe("main", () => {
  it("exits 0 and prints JSON on a successful search", () => {
    withFixture((root) => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (msg: string) => lines.push(msg);
      try {
        const code = main(
          ["valkey cache", "--json", "--repo-root", root],
          root,
          FIXED_NOW,
        );
        expect(code).toBe(0);
      } finally {
        console.log = orig;
      }
      const parsed = JSON.parse(lines.join("\n"));
      expect(parsed.verdict).toBe("precedent-candidates");
    });
  });

  it("exits 2 on a usage error and 3 on an unreadable corpus", () => {
    const empty = mkdtempSync(join(tmpdir(), "decide-empty-main-"));
    const origErr = console.error;
    console.error = () => {};
    try {
      expect(main([], empty, FIXED_NOW)).toBe(2);
      expect(main(["anything", "--repo-root", empty], empty, FIXED_NOW)).toBe(
        3,
      );
    } finally {
      console.error = origErr;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("worked example against this repository's own corpus", () => {
  // The acceptance criterion made mechanical: a question this repository
  // settled must come back settled. This repository records the toolchain
  // decision as an ADR in docs/adr, so the precedent is that record, ahead of
  // the AGENTS.md section that restates it. If the record is ever superseded
  // or reworded away this SHOULD go red and be re-pointed — a precedent pass
  // that stops finding the canonical precedent is broken in the one way the
  // hermetic tests cannot see.
  const corpus = () => loadCorpus(REPO_ROOT, { ...DEFAULT_PRECEDENT_SOURCES });

  it("ranks the toolchain decision first for the Bash-or-TypeScript question, by a clear margin", () => {
    const report = resolvePrecedent({
      repoRoot: REPO_ROOT,
      query: "Bash or Bun TypeScript for runnable tooling",
      now: FIXED_NOW,
      corpus: corpus(),
    });
    expect(report.verdict).toBe("precedent-candidates");
    expect(report.candidates[0]?.file).toBe(
      "docs/adr/ADR-0001-bun-typescript-toolchain.md",
    );
    expect(report.candidates[0]?.kind).toBe("adr");
    // Superseding the record keeps its file and wording and changes only its
    // status, which the ranking does not use: only this assertion notices.
    expect(report.candidates[0]?.status).toBe("approved");
    // A top hit that barely outscores the runner-up is a coin flip dressed as
    // a ruling; the margin is the part that makes `already-decided` safe.
    expect(report.candidates[0]?.score ?? 0).toBeGreaterThan(
      2 * (report.candidates[1]?.score ?? 0),
    );
  });

  it("runs as a CLI against this repository and exits 0", () => {
    const env = { ...process.env };
    delete env.JIG_OVERLAY;
    const proc = Bun.spawnSync(
      [process.execPath, SCRIPT, "markdown tables blank line", "--json"],
      { cwd: REPO_ROOT, env },
    );
    expectSpawnExit(proc, 0);
    const report = JSON.parse(proc.stdout.toString());
    expect(report.corpus.policy).toBeGreaterThan(3);
    expect(report.candidates.length).toBeGreaterThan(0);
  });

  it("searches JIG_CONSUMER_ROOT rather than the working directory", () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      JIG_CONSUMER_ROOT: REPO_ROOT,
    };
    delete env.JIG_OVERLAY;
    const proc = Bun.spawnSync(
      [process.execPath, SCRIPT, "markdown tables blank line", "--json"],
      { cwd: mkdtempSync(join(tmpdir(), "precedent-elsewhere-")), env },
    );
    expect(proc.stderr.toString()).toBe("");
    expectSpawnExit(proc, 0);
    expect(JSON.parse(proc.stdout.toString()).corpus.policy).toBeGreaterThan(3);
  });
});
