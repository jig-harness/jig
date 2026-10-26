/**
 * Chrome as a browser test drives it: the installed Chrome, headless, with
 * smooth scrolling on. Chrome otherwise takes smooth scrolling from the
 * system's animation setting, which Windows Server turns off, and a test that
 * watches a smooth scroll move would see the page jump instead.
 */
import { type Browser, chromium } from "playwright-core";

export function launchChrome(): Promise<Browser> {
  return chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-smooth-scrolling"],
  });
}
