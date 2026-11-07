// A gate that reports one readable finding, then prints far more than a small
// output buffer holds before it would reach the next document.
process.stdout.write("FAIL docs/a.md\n  - missing required field: title\n");
process.stdout.write(`${"x".repeat(1 << 20)}\n`);
process.exitCode = 1;
