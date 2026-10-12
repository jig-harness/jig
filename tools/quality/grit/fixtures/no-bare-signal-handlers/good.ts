// expect: 0
process.on("unhandledRejection", () => {});
process.stdout.on("error", () => {});
