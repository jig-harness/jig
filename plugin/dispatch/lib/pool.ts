/**
 * The bounded pool a tick's observe phase reads through: at most `size`
 * reads in flight at once, the rest waiting in the order they asked. A read
 * run through the pool never asks the pool for another, so a full pool
 * always drains.
 */

/** How many reads a tick's observe phase keeps in flight: well inside the forge's secondary limits. */
const OBSERVE_POOL_SIZE = 6;

export interface Pool {
  /** Run `read` once a place is free, and free the place when it settles. */
  run<T>(read: () => Promise<T>): Promise<T>;
}

export function pool(size: number = OBSERVE_POOL_SIZE): Pool {
  // NaN and Infinity are no bound: they fall back to the default.
  const limit = Number.isFinite(size)
    ? Math.max(1, Math.floor(size))
    : OBSERVE_POOL_SIZE;
  let active = 0;
  const waiting: (() => void)[] = [];
  // A freed place passes straight to the next waiting read, so none can overtake it.
  const release = () => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return {
    async run(read) {
      if (active < limit) active += 1;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await read();
      } finally {
        release();
      }
    },
  };
}
