// A command that fails with a transient warning, then one diagnostic line
// longer than the classifier reads, ending in a permanent error.
console.error("error: API rate limit exceeded for installation ID 1234567.");
console.error(`${"x".repeat(5 * 1024 * 1024)} Resource not accessible by integration (HTTP 403)`);
process.exit(1);
