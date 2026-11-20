import { readFileSync } from "node:fs";
export interface Shape {
  size: number;
}
export const read = () => readFileSync("never-followed");
