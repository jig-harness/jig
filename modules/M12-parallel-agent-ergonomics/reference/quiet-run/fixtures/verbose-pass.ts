// A command that passes after printing more than one read of the spool.
const line = `${"x".repeat(60)}\n`;
for (let i = 1; i <= 5_000; i++) process.stdout.write(`${i} ${line}`);
console.log("verbose: done");
