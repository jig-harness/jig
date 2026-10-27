/** The pieces a red-team review is checked with, without a process. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Defect } from "../../../shared/errors.ts";
import {
  detectKind,
  kindOption,
  slugFor,
  titleOf,
} from "../scripts/lib/document.ts";
import { checkFindings, extractJson } from "../scripts/lib/findings.ts";
import {
  loadPersonas,
  parsePersonas,
  personasFor,
} from "../scripts/lib/personas.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const PRD = fixture("prd.md");
const ARCHITECTURE = fixture("architecture.md");
const withoutFrontmatter = (text: string) =>
  text.replace(/^---\n[\s\S]*?\n---\n/, "");

describe("the document's kind", () => {
  test("comes from frontmatter type: first", () => {
    expect(detectKind(PRD)).toEqual({
      kind: "requirements",
      from: "frontmatter type: prd",
    });
    expect(detectKind(ARCHITECTURE)?.kind).toBe("architecture");
  });

  test("falls back to M6's template headings", () => {
    const detected = detectKind(withoutFrontmatter(PRD));
    expect(detected?.kind).toBe("requirements");
    expect(detected?.from).toContain("success metrics");
    expect(detectKind(withoutFrontmatter(ARCHITECTURE))?.kind).toBe(
      "architecture",
    );
  });

  test("a type: no kind matches is read from the headings", () => {
    const text = PRD.replace("type: prd", "type: spec");
    expect(detectKind(text)?.from).toStartWith("headings:");
  });

  test("is unknown with too few headings, or a heading inside a fence", () => {
    expect(detectKind("# Notes\n\n## Requirements\n\nSome.\n")).toBeUndefined();
    expect(
      detectKind("```\n## Problem statement\n## Success metrics\n```\n"),
    ).toBeUndefined();
  });

  test("--kind accepts prd for requirements and refuses others", () => {
    expect(kindOption("prd")).toBe("requirements");
    expect(kindOption("Architecture")).toBe("architecture");
    expect(kindOption("design")).toBeUndefined();
  });

  test("the title and the folder name come from the document", () => {
    expect(titleOf(PRD, "x")).toBe("Shared lists — product requirements");
    expect(titleOf(withoutFrontmatter(PRD), "x")).toBe(
      "Product requirements: Shared lists",
    );
    expect(slugFor("/repo/docs/PRD/Shared Lists.md", "/repo")).toBe(
      "docs-prd-shared-lists",
    );
    expect(slugFor("/elsewhere/a.md", "/repo")).toBe("a");
  });
});

describe("the personas", () => {
  const personas = loadPersonas();

  test("are the eight the kickoff names, engineering personas first", () => {
    expect(personas.map((p) => [p.id, p.name])).toEqual([
      ["critical-cto", "Critical chief technology officer"],
      ["security-auditor", "Security auditor"],
      ["performance-engineer", "Performance engineer"],
      ["cost-optimizer", "Cost optimizer"],
      ["plain-reader", "Plain-language reader"],
      ["scope-cutter", "Scope cutter"],
      ["acceptance-tester", "Acceptance tester"],
      ["day-walker", "Day-in-the-life walker"],
    ]);
  });

  test("a requirements document gets all eight, an architecture document the four engineering ones", () => {
    expect(personasFor("requirements", personas)).toHaveLength(8);
    expect(personasFor("architecture", personas).map((p) => p.id)).toEqual([
      "critical-cto",
      "security-auditor",
      "performance-engineer",
      "cost-optimizer",
    ]);
  });

  test("each says what it looks for and what a finding from it carries", () => {
    for (const persona of personas) {
      expect(persona.section, persona.id).toContain("**Look for:**");
      expect(persona.section, persona.id).toContain("**A finding carries:**");
    }
  });

  test("a malformed personas file is a defect", () => {
    const one = "## A (`a`)\n\n**Reads:** requirements\n";
    expect(() => parsePersonas(one + one)).toThrow(Defect);
    expect(() => parsePersonas("## A (`a`)\n\n**Reads:** code\n")).toThrow(
      Defect,
    );
    expect(() => parsePersonas("## A (`a`)\n\nNo reads line.\n")).toThrow(
      Defect,
    );
  });
});

describe("a persona's findings", () => {
  const finding = (extra: Record<string, unknown> = {}) => ({
    severity: "major",
    passage: "The list feels instant.",
    risk: "Nobody can tell whether it is met.",
    question: "How fast is instant, measured where?",
    ...extra,
  });
  const check = (value: unknown) =>
    checkFindings(value, "acceptance-tester", PRD, "subagent");
  const valid = {
    persona: "acceptance-tester",
    verdict: "revise",
    summary: "The outcomes cannot be tested as written.",
    findings: [finding()],
  };

  test("are read from the whole reply or its last json fence", () => {
    expect(extractJson(JSON.stringify(valid))).toEqual(valid);
    const reply = `Notes.\n\`\`\`json\n{"a": 1}\n\`\`\`\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`;
    expect(extractJson(reply)).toEqual(valid);
    expect(extractJson("no object here")).toBeUndefined();
  });

  test("a valid set is kept, stamped with how the persona ran", () => {
    const { findings, problems } = check(valid);
    expect(problems).toEqual([]);
    expect(findings?.context).toBe("subagent");
    expect(findings?.findings).toHaveLength(1);
  });

  test("a passage matches across line breaks, emphasis and list marks", () => {
    const wrapped = finding({
      passage:
        "Priority: must have - User story: As a household member, I want to invite others to my list so that we shop from one list.",
    });
    const heading = finding({ passage: "## Success metrics" });
    expect(check({ ...valid, findings: [wrapped, heading] }).problems).toEqual(
      [],
    );
  });

  test("a passage not in the document is refused", () => {
    const { problems } = check({
      ...valid,
      findings: [finding({ passage: "The list loads in 100 ms." })],
    });
    expect(problems.join("\n")).toContain(
      "finding 1: the passage is not in the document as quoted",
    );
  });

  test("each field is checked, and the verdict against the findings", () => {
    const { problems } = check({
      persona: "scope-cutter",
      verdict: "ready",
      findings: [
        finding({ severity: "blocking", question: "Fix it." }),
        { severity: "urgent" },
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "persona is scope-cutter, expected acceptance-tester",
        "summary is missing",
        'finding 1: question must be a question, ending in "?"',
        "finding 2: severity must be one of blocking, major, minor",
        "finding 2: passage is missing",
      ]),
    );
    expect(
      check({
        ...valid,
        verdict: "ready",
        findings: [finding({ severity: "blocking" })],
      }).problems,
    ).toEqual([
      "verdict ready contradicts a blocking finding: a blocking finding means revise or rethink",
    ]);
    expect(check({ ...valid, findings: [] }).problems).toEqual([
      "verdict revise names nothing to answer: add the findings",
    ]);
  });
});
