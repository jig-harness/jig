import { describe, expect, it } from "bun:test";
import { reviewerStickyBody } from "../scripts/lib/status/reviewer-sticky.ts";
import { parseDeclaredUnanchored } from "../scripts/lib/status/summary-sticky.ts";

const MARKER = "<!-- sticky -->";
const comment = (body: string) => ({
  body,
  user: { login: "reviewer[bot]" },
});

describe("sticky structure", () => {
  it("masks a code span block split by a whitespace-only line", () => {
    const body =
      "`open\n \t\n> 2 findings without a diff-anchorable line\n \t\nclose`\n";
    expect(parseDeclaredUnanchored(body)).toBe(2);
  });

  it("does not read a fence opened on a list item as evidence", () => {
    const body = `${MARKER}\n- \`\`\`\n  example\n  \`\`\`\nreal\n`;
    const kept = reviewerStickyBody(comment(body), () => true, MARKER);
    expect(kept).toContain("real");
    expect(kept).not.toContain("example");
  });

  it("keeps evidence after a list-item fence closes with indentation", () => {
    const body = `${MARKER}\n1. \`\`\`\n   <!-- fake -->\n   \`\`\`\n<!-- real -->\n`;
    const kept = reviewerStickyBody(comment(body), () => true, MARKER);
    expect(kept).toContain("<!-- real -->");
    expect(kept).not.toContain("fake");
  });
});
