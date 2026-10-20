import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderBundle } from "../scripts/browser.ts";
import { chrome, required } from "./support.ts";

/** Render one bundle of pages, each its own scenario, and return the failures. */
async function render(
  pages: Record<string, string>,
  scenarios: { name: string; url: string; ready?: string }[],
  terms: string[] = [],
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "jig-renderer-"));
  try {
    for (const [path, text] of Object.entries(pages)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const { failures } = await renderBundle(
      root,
      scenarios.map((s) => ({
        ready: "#ready",
        screenshot: `${s.name}.png`,
        ...s,
      })),
      [390],
      String(chrome),
      terms,
    );
    return failures;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const ready = '<p id="ready">ready</p>';
const browserTest = test.skipIf(!chrome && !required);

browserTest(
  "WebRTC cannot send UDP around the proxy",
  async () => {
    expect(chrome).toBeTruthy();
    let packets = 0;
    const listener = await Bun.udpSocket({
      hostname: "127.0.0.1",
      socket: { data: () => void packets++ },
    });
    try {
      await render(
        {
          "index.html": `<!doctype html><script>
            const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${listener.port}" }] });
            peer.createDataChannel("probe");
            peer.createOffer().then((offer) => peer.setLocalDescription(offer));
            setTimeout(() => document.body.insertAdjacentHTML("beforeend", '${ready}'), 2000);
          </script>`,
        },
        [{ name: "home", url: "index.html" }],
      );
      expect(packets).toBe(0);
    } finally {
      listener.close();
    }
  },
  60_000,
);

browserTest(
  "an external WebSocket is refused by the browser, not only reported",
  async () => {
    expect(chrome).toBeTruthy();
    let reached = 0;
    const external = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        reached++;
        return server.upgrade(request)
          ? undefined
          : new Response("plain", { status: 200 });
      },
      websocket: { message: () => undefined },
    });
    try {
      const failures = await render(
        {
          "index.html": `<!doctype html><script>new WebSocket("ws://127.0.0.1:${external.port}/")</script>${ready}`,
          "other.html": ready,
        },
        [
          { name: "socket", url: "index.html" },
          { name: "after", url: "other.html" },
        ],
      );
      expect(failures.some((f) => f.includes("external WebSocket"))).toBe(true);
      expect(reached).toBe(0);
    } finally {
      external.stop(true);
    }
  },
  60_000,
);

browserTest(
  "workers fail at target creation, however their constructor is reached",
  async () => {
    expect(chrome).toBeTruthy();
    const failures = await render(
      {
        "worker.js": "postMessage('started')",
        "sw.js": "self.addEventListener('fetch', () => {})",
        "dedicated.html": `<!doctype html><script>new Worker("worker.js")</script>${ready}`,
        "service.html": `<!doctype html><script>ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, "sw.js")</script>${ready}`,
        "other.html": ready,
      },
      [
        { name: "dedicated", url: "dedicated.html" },
        { name: "service", url: "service.html" },
        { name: "after", url: "other.html" },
      ],
    );
    expect(failures.some((f) => f.includes("unsupported worker target"))).toBe(
      true,
    );
    expect(
      failures.some((f) => f.includes("unsupported service_worker target")),
    ).toBe(true);
  },
  60_000,
);

browserTest(
  "the page cannot supply the verifier's answers, and control text counts",
  async () => {
    expect(chrome).toBeTruthy();
    const failures = await render(
      {
        "masked.html": `<!doctype html><script>
          Object.defineProperty(HTMLElement.prototype, "innerText", { get: () => "" });
          Document.prototype.querySelectorAll = () => [];
          Object.defineProperty(Element.prototype, "scrollWidth", { get: () => 0 });
        </script><div style="width:1800px">retired&#32;phrase</div><iframe src="about:blank"></iframe>${ready}`,
        "control.html": `<!doctype html><input value="retired&#32;phrase"><textarea placeholder="retired&#32;phrase"></textarea>${ready}`,
      },
      [
        { name: "masked", url: "masked.html" },
        { name: "control", url: "control.html" },
      ],
      ["retired phrase"],
    );
    for (const expected of [
      "masked at 390px: forbidden rendered text",
      "masked at 390px: horizontal overflow",
      "masked at 390px: iframe",
      "control at 390px: forbidden rendered text",
    ])
      expect(failures.some((f) => f.startsWith(expected))).toBe(true);
  },
  60_000,
);

browserTest(
  "a scenario is checked once its ready selector exists, not at network quiet",
  async () => {
    expect(chrome).toBeTruthy();
    const failures = await render(
      {
        "late.html": `<!doctype html><script>setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend", 'retired phrase${ready}');
        }, 1000)</script>`,
        "report.html": `<!doctype html><script src="handback-report.json"></script><script src=".handback-render/x.js"></script>${ready}`,
      },
      [
        { name: "late", url: "late.html" },
        { name: "report", url: "report.html" },
      ],
      ["retired phrase"],
    );
    expect(failures).toContain(
      "late at 390px: forbidden rendered text 'retired phrase'",
    );
    expect(
      failures.filter((f) => f.startsWith("report at 390px: HTTP 403")),
    ).toHaveLength(2);
  },
  60_000,
);
