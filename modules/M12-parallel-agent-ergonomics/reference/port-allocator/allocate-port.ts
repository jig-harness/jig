#!/usr/bin/env bun
// Deterministic per-worktree port allocator.
//
// Several agents on one machine, each in its own worktree, each starting a dev
// server or test listener, will fight over the same hardcoded port. The fix is
// to derive each worktree's port from a stable identifier (its branch or
// directory name), so the SAME worktree always gets the SAME port and two
// DIFFERENT worktrees almost never collide — no central registry, no lock.
//
// Input: a worktree identifier as arg $1 or env WORKTREE_ID (e.g. a branch or
// directory name). Config via env:
//     PORT_BASE   first port in the range (default 20000)
//     PORT_SPAN   how many ports the range holds (default 1000)
// The chosen port is always in [PORT_BASE, PORT_BASE + PORT_SPAN).
//
// Mechanism: a portable checksum (the POSIX cksum algorithm in TypeScript) of the identifier, reduced modulo PORT_SPAN and offset by
// PORT_BASE. No shell utilities, no network probe. Because it hashes,
// two ids CAN collide (see README) — keep PORT_SPAN well above the number of
// worktrees you run at once.
//
// Exit codes: 0 prints the port on stdout; 2 on a missing id or a bad range.
//
// Usage:
//   allocate-port.ts feature-login            # -> a stable port for that id
//   WORKTREE_ID=feature-login allocate-port.ts
//   PORT_BASE=30000 PORT_SPAN=500 allocate-port.ts "$(git branch --show-current)"
// POSIX cksum folds the UTF-8 bytes and then the little-endian byte length
// through the non-reflected CRC-32 polynomial before complementing the result.
export function checksum(id: string): number {
  const bytes = new TextEncoder().encode(id);
  let crc = 0;
  const feed = (byte: number) => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let i = 0; i < 8; i++)
      crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  };
  for (const byte of bytes) feed(byte);
  for (let n = bytes.length; n; n = Math.floor(n / 256)) feed(n & 255);
  return ~crc >>> 0;
}
export function main(args = process.argv.slice(2), env = process.env): number {
  const id = args[0] || env.WORKTREE_ID || "",
    base = env.PORT_BASE || "20000",
    span = env.PORT_SPAN || "1000";
  if (!id) throw new Error("no worktree id (pass as arg or set WORKTREE_ID)");
  for (const [key, val] of [
    ["PORT_BASE", base],
    ["PORT_SPAN", span],
  ])
    if (!/^[0-9]+$/.test(val ?? ""))
      throw new Error(`${key} must be a non-negative integer: ${val}`);
  const b = BigInt(base),
    s = BigInt(span);
  if (s < 1n) throw new Error(`PORT_SPAN must be >= 1: ${span}`);
  if (b < 1n) throw new Error(`PORT_BASE must be >= 1: ${base}`);
  if (b + s > 65536n)
    throw new Error("range [PORT_BASE, PORT_BASE+PORT_SPAN) exceeds 65535");
  console.log(String(b + (BigInt(checksum(id)) % s)));
  return 0;
}
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
