import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { applyReadyBadge, badgeText, markWith, titleWith } from "./badge.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="m0 0"/></svg>';
const HREF = `data:image/svg+xml,${encodeURIComponent(SVG)}`;

test("the count is written as one digit, then 9+", () => {
  expect([1, 9, 10, 42].map(badgeText)).toEqual(["1", "9", "9+", "9+"]);
});

test("the title carries the count only while something is ready", () => {
  expect(titleWith("Dispatch", 0)).toBe("Dispatch");
  expect(titleWith("Dispatch", 3)).toBe("(3) Dispatch");
});

test("the mark gets its count drawn last, and is left alone at zero or when it is not an svg address", () => {
  expect(markWith(HREF, 0)).toBe(HREF);
  expect(markWith("/favicon.ico", 2)).toBe("/favicon.ico");
  const drawn = decodeURIComponent(markWith(HREF, 12)).slice(
    "data:image/svg+xml,".length,
  );
  expect(drawn.startsWith(SVG.slice(0, -"</svg>".length))).toBe(true);
  expect(drawn).toContain(">9+</text></svg>");
  expect(decodeURIComponent(markWith(HREF, 3))).toContain(">3</text></svg>");
});

test("the page badge updates, clears, and restores the page when its owner unmounts", async () => {
  const window = new Window();
  const icon = window.document.createElement("link");
  icon.rel = "icon";
  icon.href = HREF;
  window.document.head.append(icon);
  window.document.title = "Dispatch";
  const priorDocument = globalThis.document;
  const priorNavigator = globalThis.navigator;
  const calls: string[] = [];
  Object.assign(globalThis, {
    document: window.document,
    navigator: {
      setAppBadge: async (count: number) => calls.push(`set:${count}`),
      clearAppBadge: async () => calls.push("clear"),
    },
  });
  try {
    const cleanup = applyReadyBadge(4);
    expect(document.title).toBe("(4) Dispatch");
    expect(document.querySelector("link")?.getAttribute("href")).not.toBe(HREF);
    await Promise.resolve();
    cleanup();
    expect(document.title).toBe("Dispatch");
    expect(document.querySelector("link")?.getAttribute("href")).toBe(HREF);
    expect(calls).toEqual(["set:4", "clear"]);
  } finally {
    Object.assign(globalThis, {
      document: priorDocument,
      navigator: priorNavigator,
    });
  }
});

test("the page badge tolerates unavailable or rejected badge APIs", async () => {
  const window = new Window();
  const priorDocument = globalThis.document;
  const priorNavigator = globalThis.navigator;
  Object.assign(globalThis, {
    document: window.document,
    navigator: {
      clearAppBadge: async () => Promise.reject(new Error("refused")),
    },
  });
  try {
    expect(() => applyReadyBadge(0)).not.toThrow();
    await Promise.resolve();
  } finally {
    Object.assign(globalThis, {
      document: priorDocument,
      navigator: priorNavigator,
    });
  }
});
