import { describe, expect, it } from "bun:test";
import { nextTheme, schemeOf, themeOf } from "./theme.ts";

describe("the theme", () => {
  it("is the one the address names, over what the browser kept", () => {
    expect(themeOf("?theme=dark", "light")).toBe("dark");
    expect(themeOf("?theme=light", null)).toBe("light");
  });

  it("is the one the browser kept when the address names none it knows", () => {
    expect(themeOf("?theme=blue", "dark")).toBe("dark");
    expect(themeOf("", "light")).toBe("light");
  });

  it("follows the device otherwise", () => {
    expect(themeOf("", null)).toBe("auto");
    expect(themeOf("", "blue")).toBe("auto");
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
