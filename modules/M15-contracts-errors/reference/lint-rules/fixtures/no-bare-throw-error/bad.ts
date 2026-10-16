// expect: 8
export function a(): never {
  throw new Error("x");
}
export function b(): never {
  throw new TypeError("x");
}
export function c(): never {
  throw Error("x");
}
export function d(): never {
  throw new globalThis.RangeError("x");
}
export function e(): never {
  throw new Error("x", { cause: new SyntaxError("y") });
}
export function f(): never {
  throw AggregateError([], "x");
}
export function g(): never {
  throw globalThis.URIError("x");
}
export function h(): never {
  throw new Error();
}
