// A command that fails with output that does not end its last line.
process.stdout.write("failure");
process.stderr.write("diagnostic");
process.exit(1);
