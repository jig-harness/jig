// expect: 3
const release = () => {};
process.on("exit", release);
process.on("SIGINT", () => release());
process.once("SIGTERM", release);
