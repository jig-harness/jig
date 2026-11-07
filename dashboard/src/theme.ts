/**
 * The page's theme: the device's, or one a person chose. A choice is kept in
 * this browser and in the address's `theme`, so a link carries it; the address
 * wins over what the browser kept.
 */
import { useCallback, useEffect, useState } from "react";
import { readKept, writeKept } from "./kept.ts";
import { replaceParam, withParam } from "./search.ts";

export type Theme = "auto" | "light" | "dark";

const KEY = "theme";

const NEXT: Record<Theme, Theme> = {
  auto: "light",
  light: "dark",
  dark: "auto",
};

function named(value: string | null): Theme | null {
  return value === "auto" || value === "light" || value === "dark"
    ? value
    : null;
}

function forced(value: string | null): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/**
 * The theme the address names (`auto` included, so a link can ask for the
 * device's), else the one this browser kept, else the device's.
 */
export function themeOf(search: string, kept: string | null): Theme {
  return (
    named(new URLSearchParams(search).get("theme")) ?? forced(kept) ?? "auto"
  );
}

/** The `color-scheme` a theme asks for. */
export function schemeOf(theme: Theme): string {
  return theme === "auto" ? "light dark" : theme;
}

/** The theme a switch moves to from `theme`. */
export function nextTheme(theme: Theme): Theme {
  return NEXT[theme];
}

/** A shareable query names the effective theme, the device's included. */
export function themeSearch(search: string, theme: Theme): string {
  return withParam(search, "theme", theme);
}

/** The theme, and how to change it. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(() =>
    themeOf(location.search, readKept(KEY)),
  );
  useEffect(() => {
    // The document's own scheme too, so what lies past the page's edge matches it.
    document.documentElement.style.colorScheme = schemeOf(theme);
    // Auto without a choice leaves the address as it was.
    if (theme !== "auto") replaceParam("theme", theme);
  }, [theme]);
  const choose = useCallback((next: Theme) => {
    setTheme(next);
    writeKept(KEY, next === "auto" ? null : next);
    replaceParam("theme", next);
  }, []);
  return [theme, choose];
}
