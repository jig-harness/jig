import { describe, expect, it } from "bun:test";
import { actionOf } from "./keys.ts";

const press = (
  key: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("the key map", () => {
  it("opens the palette on ⌘K and Ctrl-K, whatever the case", () => {
    expect(actionOf(press("k", { metaKey: true }), false)).toEqual({
      kind: "palette",
    });
    expect(actionOf(press("K", { ctrlKey: true }), false)).toEqual({
      kind: "palette",
    });
    expect(
      actionOf(press("k", { ctrlKey: true, altKey: true }), false),
    ).toBeNull();
  });

  it("moves with j and k, toggles with Enter and o, and acts on the card with p, i and c", () => {
    expect(actionOf(press("j"), false)).toEqual({ kind: "move", by: 1 });
    expect(actionOf(press("k"), false)).toEqual({ kind: "move", by: -1 });
    expect(actionOf(press("Enter"), false)).toEqual({ kind: "toggle" });
    expect(actionOf(press("o"), false)).toEqual({ kind: "toggle" });
    expect(actionOf(press("p"), false)).toEqual({ kind: "open", what: "pr" });
    expect(actionOf(press("i"), false)).toEqual({
      kind: "open",
      what: "issue",
    });
    expect(actionOf(press("c"), false)).toEqual({ kind: "copy" });
    expect(actionOf(press("/"), false)).toEqual({ kind: "filter" });
    expect(actionOf(press("?"), false)).toEqual({ kind: "help" });
  });

  it("reads g and a letter as one, and a letter no view takes as nothing", () => {
    expect(actionOf(press("g"), false)).toEqual({ kind: "chord" });
    expect(actionOf(press("m"), true)).toEqual({ kind: "view", view: "merge" });
    expect(actionOf(press("n"), true)).toEqual({ kind: "view", view: "needs" });
    expect(actionOf(press("r"), true)).toEqual({
      kind: "view",
      view: "running",
    });
    expect(actionOf(press("q"), true)).toEqual({ kind: "view", view: "queue" });
    expect(actionOf(press("h"), true)).toEqual({
      kind: "view",
      view: "history",
    });
    expect(actionOf(press("j"), true)).toBeNull();
    expect(actionOf(press("m"), false)).toBeNull();
  });

  it("leaves the browser's own chords alone", () => {
    expect(actionOf(press("c", { ctrlKey: true }), false)).toBeNull();
    expect(actionOf(press("j", { metaKey: true }), false)).toBeNull();
    expect(actionOf(press("p", { altKey: true }), false)).toBeNull();
  });
});
