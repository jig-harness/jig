// A command that reads its input from standard input and prints it.
process.stdout.write(await Bun.stdin.text());
