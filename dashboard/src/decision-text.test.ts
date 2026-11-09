/**
 * The whole decision comes from pull requests, so what it renders is checked as
 * markup a browser would hold: nothing in it may run or fetch by itself.
 */
import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionText } from "./decision-text.tsx";

function rendered(source: string, lines = false) {
  const window = new Window();
  window.document.body.innerHTML = renderToStaticMarkup(
    createElement(DecisionText, { source, lines }),
  );
  return window.document.body;
}

describe("the decision's Markdown", () => {
  it("renders the shape a drive records", () => {
    const body = rendered(
      [
        "## Question",
        "Should the retry cover 4xx responses too?",
        "",
        "## Options",
        "- **A** retry 5xx only. Changes: the helper. Costs: 429 stays.",
        "- **B** retry 429 too. Changes: a test. Costs: a backoff cap.",
        "",
        "## Steps for a person",
        "Comment `answer PRRT_x1: A` on the pull request.",
      ].join("\n"),
    );
    expect([...body.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "Question",
      "Options",
      "Steps for a person",
    ]);
    expect(body.querySelectorAll("li").length).toBe(2);
    expect(body.querySelector("li strong")?.textContent).toBe("A");
    expect(body.querySelector("code")?.textContent).toBe("answer PRRT_x1: A");
  });

  it("renders a park's plain sentence", () => {
    expect(
      rendered("One plain sentence.").querySelector("p")?.textContent,
    ).toBe("One plain sentence.");
  });
});

describe("raw HTML in the text", () => {
  const live = [
    "script",
    "img",
    "iframe",
    "object",
    "embed",
    "svg",
    "style",
    "form",
    "input",
    "link",
    "meta",
    "base",
    "video",
    "audio",
  ].join(", ");

  it("stays text, as a block", () => {
    const body = rendered(
      '<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>',
    );
    expect(body.querySelectorAll(live).length).toBe(0);
    expect(body.textContent).toContain('<script>alert("x")</script>');
  });

  it("stays text, inline", () => {
    const body = rendered(
      'Before <img src=x onerror=alert(1)> and <a href="javascript:alert(1)">link</a> after',
    );
    expect(body.querySelectorAll(live).length).toBe(0);
    expect(body.querySelectorAll("a").length).toBe(0);
    expect(body.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("gives nothing an event handler or style", () => {
    const body = rendered(
      '<div onclick="alert(1)" style="position:fixed">x</div>\n\n**<b onmouseover=alert(1)>y</b>**',
    );
    for (const element of body.querySelectorAll("*")) {
      const names = element.getAttributeNames();
      expect(names.filter((n) => n.startsWith("on"))).toEqual([]);
      expect(names).not.toContain("style");
    }
  });
});

describe("links in the text", () => {
  const dangerous = [
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x]( javascript:alert(1))",
    "[x](java\tscript:alert(1))",
    "[x](javascript&#58;alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:alert(1))",
    "[x](file:///etc/passwd)",
    "[x](/receipt)",
    "[x](//forge.example/a)",
    "<javascript:alert(1)>",
    "[x][ref]\n\n[ref]: javascript:alert(1)",
  ];

  it("become no link unless they go to the web or to mail", () => {
    for (const source of dangerous) {
      const body = rendered(source);
      expect({ source, links: body.querySelectorAll("a").length }).toEqual({
        source,
        links: 0,
      });
    }
  });

  it("keep their words when they become no link", () => {
    expect(rendered("[the words](javascript:alert(1))").textContent).toContain(
      "the words",
    );
  });

  it("open away from the page and say nothing of where they came from", () => {
    const link = rendered(
      "[x](https://forge.example/a/b/pull/1)",
    ).querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://forge.example/a/b/pull/1");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("show an image only as its description, so it fetches nothing", () => {
    const body = rendered(
      "![a tracking pixel](https://elsewhere.example/p.png)",
    );
    expect(body.querySelectorAll("img").length).toBe(0);
    expect(body.textContent).toContain("a tracking pixel");
  });

  it("renders a log reason's emphasis and code, and keeps its line breaks readable", () => {
    const body = rendered("stopped **8** (parked)\nwaiting on `PRRT_x1`", true);
    expect(body.querySelector("strong")?.textContent).toBe("8");
    expect(body.querySelector("code")?.textContent).toBe("PRRT_x1");
    expect(body.querySelector(".quote")?.className).toContain("lines");
    expect(body.textContent).toContain(
      "stopped 8 (parked)\nwaiting on PRRT_x1",
    );
  });
});
