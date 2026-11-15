import { Defect } from "../outcome.ts";

/** Read unique keys in sequential chunks within the system's single-request cap. */
export async function batch<Key, Value>(
  keys: readonly Key[],
  cap: number,
  read: (keys: readonly Key[]) => Promise<readonly Value[]>,
): Promise<Value[]> {
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new Defect("A batch cap must be a positive integer");
  const unique = [...new Set(keys)];
  const answers: Value[] = [];
  for (let i = 0; i < unique.length; i += cap)
    answers.push(...(await read(unique.slice(i, i + cap))));
  return answers;
}
