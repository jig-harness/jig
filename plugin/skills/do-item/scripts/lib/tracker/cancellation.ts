/** Keep cancellation at the boundary of every prerequisite and effect request. */
export async function cancellableRequest<T>(
  signal: AbortSignal | undefined,
  send: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const value = await send();
  signal?.throwIfAborted();
  return value;
}
