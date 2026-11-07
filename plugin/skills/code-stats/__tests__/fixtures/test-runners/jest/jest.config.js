// Checks live beside the code they check, named *.check.js.
module.exports = {
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.check.js"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/src/slow/"],
  transform: { "^.+\\.js$": require.resolve("./transform.js") },
};
