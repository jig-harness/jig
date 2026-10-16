// A command killed by a signal before it finished.
console.log("started");
process.kill(process.pid, "SIGTERM");
await Bun.sleep(5_000);
