/**
 * A paged read whose page shrinks when the system it reads times out.
 *
 * A system that ends a request after a fixed time (GitHub ends a GraphQL
 * query after 10 seconds) answers a page that costs too much to compute with
 * a gateway error, 502 or 504, or with no answer before the caller's
 * deadline. Asking again for the same page fails the same way; asking for a
 * smaller one does not. So a page that times out is asked for again from the
 * same place at half its size, down to one item, and only a page of one that
 * still times out fails the read. Once a page has shrunk the rest of the read
 * keeps the smaller size, and the read reports the size that last answered,
 * so a caller can start its next read there.
 *
 * Any other failure ends the read at once: only a timeout says the page was
 * too large.
 */
import { failed, ok, type Failure, type Outcome } from "../outcome.ts";

/** The failure code a page's fetch returns when the system timed out: the one code that shrinks the page. */
export const TIMED_OUT = "timed-out";

/** One page as its fetch read it: what it holds, and where the next page starts, `null` after the last. */
export interface Page<P, C> {
  value: P;
  /** How many items the page held, which the read counts. */
  items: number;
  next: C | null;
}

/** A read in pages. */
export interface PagedRead<P, C, Code extends string> {
  /** Where the first page starts. */
  start: C;
  /** The page size to begin with. */
  size: number;
  /** One page of at most `size` items, from `at`; a timeout fails as `TIMED_OUT`. */
  fetch(size: number, at: C): Promise<Outcome<Page<P, C>, Code>>;
}

/** What a paged read read. */
export interface Paged<P> {
  /** Each page as its fetch read it, in order. */
  pages: P[];
  items: number;
  /** The page size that last answered: the one to begin the next read with. */
  size: number;
  /** The pages that timed out and were asked for again at a smaller size. */
  shrinks: number;
}

/** Half of `size`, never under one. */
function half(size: number): number {
  return Math.max(1, Math.floor(size / 2));
}

/** A failure after the page shrank, saying how far it shrank. */
function after<Code extends string>(
  failure: Failure<Code>,
  from: number,
): Outcome<never, Code> {
  return failed(
    failure.code,
    `${failure.reason} (at a page of 1, shrunk from ${from})`,
    failure.cause,
  );
}

/** Every page of `read`, its page halving on each timeout down to one item; the first failure that is not a timeout, or a timeout at a page of one. */
export async function readPaged<P, C, Code extends string>(
  read: PagedRead<P, C, Code>,
): Promise<Outcome<Paged<P>, Code>> {
  const first = Math.max(1, Math.floor(read.size));
  const out: Paged<P> = { pages: [], items: 0, size: first, shrinks: 0 };
  let at: C | null = read.start;
  while (at !== null) {
    const page = await read.fetch(out.size, at);
    if (!page.ok) {
      if (page.failure.code !== TIMED_OUT) return page;
      if (out.size === 1)
        return out.shrinks === 0 ? page : after(page.failure, first);
      out.size = half(out.size);
      out.shrinks += 1;
      continue;
    }
    out.pages.push(page.value.value);
    out.items += page.value.items;
    at = page.value.next;
  }
  return ok(out);
}

/**
 * Whether a call over HTTP timed out: its deadline passed, or the system
 * answered 502 or 504, which a gateway gives for a request it gave up on.
 * `said` is what the client printed of the answer.
 */
export function timedOut(said: string, deadlinePassed: boolean): boolean {
  return deadlinePassed || /\bHTTP 50[24]\b/.test(said);
}
