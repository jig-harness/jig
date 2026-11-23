import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { keepTokens } from "./forge-token.ts";
import { KeptTokenRecovery } from "./send-settings.tsx";

const memory = new Map<string, string>();
const stub = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};
beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: stub },
    configurable: true,
  });
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
});

test("a refused page offers to forget a kept token, and nothing when none is kept", () => {
  keepTokens([]);
  expect(renderToStaticMarkup(<KeptTokenRecovery />)).toBe("");
  keepTokens([{ token: "pat-a", login: "maintainer-a", at: 1, owners: [] }]);
  const html = renderToStaticMarkup(<KeptTokenRecovery />);
  expect(html).toContain("Forget this token");
  expect(html).not.toContain("GitHub token</span>");
  // Recovery is forget-only: nothing that reads the token or rewrites its owners.
  expect(html).not.toContain("Test again");
  expect(html).not.toContain("Save owners");
  expect(html).not.toContain("Send is on");
  keepTokens([]);
});
