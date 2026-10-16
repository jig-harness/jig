import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXED_PAGES, readmeLead, render, rootFile, SECTIONS } from "./llms.ts";

const root = join(import.meta.dir, "../../..");

test("a file is a title, a summary and groups of links with a line each", () => {
  expect(
    render({
      title: "T",
      summary: "S",
      groups: [
        { heading: "G", links: [{ title: "A", route: "/a/", note: "n" }] },
      ],
    }),
  ).toBe(
    "# T\n\n> S\n\n## G\n\n- [A](https://jig-harness.dev/a/index.md): n\n",
  );
});

test("the root index links each section's own file and no glossary", () => {
  const text = render(rootFile("S", "I."));
  for (const s of SECTIONS)
    expect(text).toContain(`(https://jig-harness.dev/${s.slug}/llms.txt)`);
  expect(text).not.toContain("glossary");
});

test("a page is linked as its Markdown twin, a file as itself", () => {
  const text = render(rootFile("S", "I."));
  expect(text).toContain("(https://jig-harness.dev/features/index.md)");
  expect(text).toContain("(https://jig-harness.dev/modules/llms.txt)");
});

test("every section with fixed pages is a section", () => {
  const slugs = SECTIONS.map((s) => s.slug);
  for (const slug of Object.keys(FIXED_PAGES)) expect(slugs).toContain(slug);
});

test("the README's tagline and opening paragraph are the root's summary", () => {
  const lead = readmeLead(readFileSync(join(root, "README.md"), "utf8"));
  expect(lead.summary).toStartWith("AI-native delivery practices");
  expect(lead.intro).toStartWith("Jig is a modular collection");
  expect(lead.intro).not.toContain("**");
});
