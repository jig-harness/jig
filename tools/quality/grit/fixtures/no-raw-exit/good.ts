// expect: 0
export function stop(): number {
  process.exitCode = 2;
  return 2;
}
