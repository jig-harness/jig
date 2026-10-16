// A command that passes with a warning on stderr, as a linter does.
console.log("checked 12 files");
console.error("warning: 1 rule at warn level has 3 findings");
process.exit(0);
