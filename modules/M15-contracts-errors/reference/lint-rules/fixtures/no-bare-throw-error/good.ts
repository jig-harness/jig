// expect: 0
class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function typed(): never {
  throw new DomainError("ORD-001", "x");
}
export function rethrown(e: unknown): never {
  throw e;
}
export function defect(): never {
  throw invariantFailed("x");
}
// Built, not thrown: the defect primitive's own module is excluded by path.
function invariantFailed(message: string): Error {
  return new Error(message);
}
export const kept = new TypeError("built, not thrown");
