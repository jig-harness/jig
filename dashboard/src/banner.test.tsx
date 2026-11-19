import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Banner } from "./banner.tsx";

const DETAIL =
  "The newest tick that tried could not read it: the repository lookup waits for the rate limit: gh repo view exited 1: the dispatcher's share (50%) of the complexity window is spent; 2400 of 5000 are left to passes and people";

/** The banner's markup: its heading, its body, and its folded part apart. */
function rendered(detail?: string): { heading: string; whole: string } {
  const whole = renderToStaticMarkup(
    createElement(Banner, {
      title:
        "example-org/mobile: GitHub quota paused until 17:30, dispatcher's share spent; showing 16:05 data.",
      body: "Its needs, queue and sessions below are as of the 16:05 tick, 42 min ago.",
      command: false,
      ...(detail === undefined ? {} : { detail }),
    }),
  );
  const heading = /<h2>(.*?)<\/h2>/.exec(whole)?.[1] ?? "";
  return { heading, whole };
}

it("leads with the short line and keeps the detail behind a closed fold", () => {
  const { heading, whole } = rendered(DETAIL);
  expect(heading).toContain("GitHub quota paused until 17:30");
  expect(heading).not.toContain("gh repo view");
  expect(whole).toContain('aria-label="What stopped the read"');
  // A fold renders closed: its detail is not on the page until it is opened.
  expect(whole).not.toContain("left to passes and people");
});

it("has no fold when there is no detail", () => {
  expect(rendered().whole).not.toContain("What stopped the read");
});
