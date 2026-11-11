import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OptionText } from "./option-text.tsx";

it("renders option details as labels and text without interpreting markup", () => {
  const html = renderToStaticMarkup(
    createElement(OptionText, {
      option: {
        name: "Extend",
        changes: "Add coverage",
        costs: "More tests",
        recommended: true,
        details: [
          {
            label: "Future field",
            text: "<script>Shown without field-specific rendering</script>",
          },
        ],
      },
    }),
  );
  expect(html).toContain("Future field");
  expect(html).toContain("Shown without field-specific rendering");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
