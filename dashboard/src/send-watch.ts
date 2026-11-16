/** A bounded burst of read-only refreshes after posting, until the tick reports the answer's outcome. */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";

export const ANSWER_POLL_MS = 3_000;
export const ANSWER_WAIT_MS = 90_000;
interface Watch {
  repo: string;
  target: string;
  urls: string[];
  until: number;
}
const watches = new Map<string, Watch>();
const listeners = new Set<() => void>();
let revision = 0;

export function watchAnswer(
  repo: string,
  target: string,
  urls: string[],
  now = performance.now(),
): void {
  watches.set(`${repo} ${target}`, {
    repo,
    target,
    urls: [...urls],
    until: now + ANSWER_WAIT_MS,
  });
  revision++;
  for (const listener of listeners) listener();
}
export function subscribeAnswerWatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function answerWatchRevision(): number {
  return revision;
}

/** The next interval; expiry and a tick outcome both end the burst, even when the need vanished before this page read it. */
export function answerReadInterval(
  line: LineSnapshot | null,
  now = performance.now(),
): number {
  for (const [key, watch] of watches) {
    const need = line?.needs.find(
      (n) => n.repo === watch.repo && n.target === watch.target,
    );
    const settled = watch.urls.every((url) =>
      need?.decisions.some(
        (d) =>
          d.acted?.outcome != null && d.acted.answer?.startsWith(`${url} `),
      ),
    );
    const held = line?.answeredHolds?.some(
      (h) => h.repo === watch.repo && h.target === watch.target,
    );
    if (now >= watch.until || settled || held) watches.delete(key);
  }
  return watches.size > 0 ? ANSWER_POLL_MS : 60_000;
}
