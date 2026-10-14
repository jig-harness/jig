export const orderTotal = (lines: number[]) => lines.reduce((a, b) => a + b, 0);
