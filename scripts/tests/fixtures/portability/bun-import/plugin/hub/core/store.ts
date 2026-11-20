import { Database } from "bun:sqlite";

export const open = () => new Database(":memory:");
