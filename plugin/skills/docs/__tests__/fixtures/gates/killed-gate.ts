// A gate that reports one readable finding, then is killed by a signal before
// it would reach the next document.
process.stdout.write("FAIL docs/a.md\n  - missing required field: title\n");
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.kill(process.pid, "SIGKILL");
