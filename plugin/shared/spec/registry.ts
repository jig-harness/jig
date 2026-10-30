/**
 * Every spec adapter the resolver knows, in its default order: the
 * repository layouts first, then the item's own body, which every
 * repository has. `specs.adapters` orders or restricts them by name.
 */
import type { SpecAdapter } from "./adapter.ts";
import { bodyAdapter } from "./adapters/body.ts";

export const ADAPTERS: readonly SpecAdapter[] = [bodyAdapter];
