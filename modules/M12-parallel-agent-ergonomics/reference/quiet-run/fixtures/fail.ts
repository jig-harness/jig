// A command that fails: progress on stdout, the failure on stderr.
for (let i = 1; i <= 30; i++) console.log(`line ${i} of a failing run`);
console.error("assertion failed: expected 2, got 3");
process.exit(1);
