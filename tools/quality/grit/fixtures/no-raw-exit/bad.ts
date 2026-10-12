// expect: 3
export function stop(): never {
  process.exit(2);
}
export function quit(): void {
  process.exit();
}
function main(): number {
  return 0;
}
if (import.meta.main) process.exit(main());
