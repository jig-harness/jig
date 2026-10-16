// expect: 0
export const raw = JSON.parse("{}") as unknown;
export const plain: unknown = JSON.parse("{}");
export const other = String("{}") as string;
export const f: unknown = JSON.parse("{}");
