/** `pending`, or the rejection `signal`'s abort gives; `pending` itself runs on for its other callers. */
export function waitFor<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      pending.catch(() => undefined);
      reject(signal.reason);
      return;
    }
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", stop);
    });
  });
}
