/**
 * What the page shows of Ready to merge outside its own window: the count in
 * the title and on the favicon of a tab, and on the icon of an installed app
 * where the browser has a badge for it. All of it is set while the page is
 * open, from the same count the Merge tab carries; nothing here reaches a
 * closed app.
 */
import { useEffect } from "react";

/** What the browser's app badge offers, where it offers one. */
interface AppBadge {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/** An svg address whose payload is entirely percent-encoded, so no markup characters reach the drawing. */
const ENCODED_SVG = /^data:image\/svg\+xml,[A-Za-z0-9%._~!*'()-]*$/;
/** The end of an svg, as an address holds it. */
const SVG_END = encodeURIComponent("</svg>");
/** The attribute that keeps the address the page was built with. */
const BUILT = "data-built";

/** The count as a favicon has room for it: one digit, or `9+`. */
export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** The title with the count in front of it; the title itself while there is nothing ready. */
export function titleWith(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * The address of an svg with a count drawn on its corner, in the mark's own
 * coordinates (its `viewBox` is 46 wide); the address itself when the count
 * is zero or it is not an svg this can draw on.
 */
export function markWith(href: string, count: number): string {
  const at = href.lastIndexOf(SVG_END);
  if (count <= 0 || !ENCODED_SVG.test(href) || at < 0) return href;
  const text = badgeText(count);
  const size = text.length > 1 ? 17 : 22;
  const drawn =
    '<circle cx="31" cy="28" r="14" fill="#c8372d"/>' +
    `<text x="31" y="${28 + size * 0.36}" font-family="sans-serif" font-weight="700" font-size="${size}" text-anchor="middle" fill="#fff">${text}</text>`;
  return `${href.slice(0, at)}${encodeURIComponent(drawn)}${href.slice(at)}`;
}

/** Sets or clears the installed app's badge; a browser with no badge, or one that refuses it, is left alone. */
function setAppBadge(count: number): void {
  const app = navigator as Navigator & AppBadge;
  const done = count > 0 ? app.setAppBadge?.(count) : app.clearAppBadge?.();
  done?.catch(() => undefined);
}

/** Updates the page's badge and returns the cleanup required when its owner disappears. */
export function applyReadyBadge(count: number): () => void {
  const title = document.title;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const href = link?.getAttribute("href") ?? null;
  const builtBefore = link?.getAttribute(BUILT) ?? null;
  if (link !== null) {
    const built = builtBefore ?? href ?? "";
    link.setAttribute(BUILT, built);
    link.setAttribute("href", markWith(built, count));
  }
  document.title = titleWith(title.replace(/^\(\d+\) /, ""), count);
  setAppBadge(count);
  return () => {
    document.title = title;
    if (link !== null) {
      if (href === null) link.removeAttribute("href");
      else link.setAttribute("href", href);
      if (builtBefore === null) link.removeAttribute(BUILT);
      else link.setAttribute(BUILT, builtBefore);
    }
    setAppBadge(0);
  };
}

/** Keeps the tab's title and icon, and the installed app's badge, at the count of pull requests ready to merge. */
function useReadyBadge(ready: number | undefined): void {
  const count = ready ?? 0;
  useEffect(() => applyReadyBadge(count), [count]);
  // The app badge is shared by every window of the app, and the latest set or clear wins:
  // a window that comes back into view puts its own count back.
  useEffect(() => {
    const reassert = () => {
      if (document.visibilityState !== "hidden") setAppBadge(count);
    };
    window.addEventListener("focus", reassert);
    document.addEventListener("visibilitychange", reassert);
    return () => {
      window.removeEventListener("focus", reassert);
      document.removeEventListener("visibilitychange", reassert);
    };
  }, [count]);
}

/** Renders nothing; it holds the badge for the page, so the page itself carries none of its logic. */
export function ReadyBadge({ ready }: { ready: number | undefined }): null {
  useReadyBadge(ready);
  return null;
}
