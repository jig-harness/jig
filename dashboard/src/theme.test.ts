import { describe, expect, it } from "bun:test";
import {
  nextTheme,
  schemeOf,
  syncBarColour,
  themeOf,
  themeSearch,
} from "./theme.ts";

function bar(): { metas: HTMLMetaElement[]; doc: Document } {
  const metas = [
    "(prefers-color-scheme: light)",
    "(prefers-color-scheme: dark)",
  ].map((media) => ({ media, dataset: {} }) as unknown as HTMLMetaElement);
  const doc = { querySelectorAll: () => metas } as unknown as Document;
  return { metas, doc };
}

describe("the theme", () => {
  it("is the one the address names, over what the browser kept", () => {
    expect(themeOf("?theme=dark", "light")).toBe("dark");
    expect(themeOf("?theme=light", null)).toBe("light");
  });

  it("is the one the browser kept when the address names none it knows", () => {
    expect(themeOf("?theme=blue", "dark")).toBe("dark");
    expect(themeOf("", "light")).toBe("light");
  });

  it("is the device's when the address names it, over what the browser kept", () => {
    expect(themeOf("?theme=auto", "dark")).toBe("auto");
  });

  it("follows the device otherwise", () => {
    expect(themeOf("", null)).toBe("auto");
    expect(themeOf("", "blue")).toBe("auto");
  });

  it("names every theme in a shareable query", () => {
    expect(themeSearch("?token=t", "auto")).toBe("?token=t&theme=auto");
    expect(themeSearch("?theme=dark", "light")).toBe("?theme=light");
  });

  it("asks for the scheme it names, or both for the device's", () => {
    expect(schemeOf("dark")).toBe("dark");
    expect(schemeOf("light")).toBe("light");
    expect(schemeOf("auto")).toBe("light dark");
  });

  it("switches from the device's to light, dark and back", () => {
    expect(nextTheme("auto")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("auto");
  });
});

describe("the browser bar's colour", () => {
  it("keeps only the chosen theme's colour in force", () => {
    const { metas, doc } = bar();
    syncBarColour("dark", doc);
    expect(metas.map((m) => m.media)).toEqual(["not all", "all"]);
    syncBarColour("light", doc);
    expect(metas.map((m) => m.media)).toEqual(["all", "not all"]);
  });

  it("gives each colour its own device scheme back on auto", () => {
    const { metas, doc } = bar();
    syncBarColour("dark", doc);
    syncBarColour("auto", doc);
    expect(metas.map((m) => m.media)).toEqual([
      "(prefers-color-scheme: light)",
      "(prefers-color-scheme: dark)",
    ]);
  });
});
