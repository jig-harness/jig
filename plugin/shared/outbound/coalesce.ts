/** One read per key in a run, moved from the dispatcher's read-once maps. */
export function coalesce<K, T>(
  reads: Map<K, Promise<unknown>>,
  key: K,
  read: () => Promise<T>,
): Promise<T> {
  let answer = reads.get(key);
  if (answer === undefined) {
    answer = read();
    reads.set(key, answer);
  }
  return answer as Promise<T>;
}
