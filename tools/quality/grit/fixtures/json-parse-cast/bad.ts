// expect: 5
type Pr = { number: number };
export const a = JSON.parse("{}") as Pr;
export const b = JSON.parse("{}", (_k, v) => v) as { number: number };
export const c = JSON.parse("[]") as Pr[];
export const d = JSON.parse("{}") as unknown as Pr;
export const e: Pr = JSON.parse("{}");
