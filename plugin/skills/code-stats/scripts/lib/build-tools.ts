/**
 * The build tools the default `build` area recognises, as data: each tool,
 * its ecosystem and the globs of its files, with one example path. The same
 * table builds the area, explains a match (`build tool: Cargo`), gives a
 * build file its kind (configuration or code) when no fixture or test
 * convention claimed it first, and is listed in the README and
 * CONFIGURATION.md. A build file in a fixture or test folder keeps that
 * kind; its area is `build` either way. Package-manager manifests that
 * are not a build tool's (`package.json`, `pyproject.toml`, `go.mod`,
 * `Gemfile`, `composer.json`, `requirements*.txt`) are not here.
 */

import { compileTools, type ToolRule } from "./tool-rules.ts";

export const BUILD_TOOLS: readonly ToolRule[] = [
  {
    tool: "Gradle",
    ecosystem: "JVM",
    paths: [
      "**/build.gradle",
      "**/build.gradle.kts",
      "**/settings.gradle",
      "**/settings.gradle.kts",
      "**/gradle.properties",
      "gradle/**",
      "**/gradlew",
      "**/gradlew.bat",
      "buildSrc/**",
    ],
    example: "app/build.gradle.kts",
  },
  {
    tool: "Maven",
    ecosystem: "JVM",
    paths: ["**/pom.xml", ".mvn/**", "**/mvnw", "**/mvnw.cmd"],
    example: "service/pom.xml",
  },
  {
    tool: "sbt",
    ecosystem: "JVM",
    paths: ["**/build.sbt", "project/*.sbt", "project/build.properties"],
    example: "build.sbt",
  },
  {
    tool: "Ant",
    ecosystem: "JVM",
    paths: ["**/build.xml"],
    example: "build.xml",
  },
  {
    tool: "Mill",
    ecosystem: "JVM",
    paths: ["**/build.sc", "**/build.mill"],
    example: "build.mill",
  },
  {
    tool: "Cargo",
    ecosystem: "Rust",
    paths: [
      "**/Cargo.toml",
      "**/build.rs",
      "**/.cargo/**",
      "**/rust-toolchain",
      "**/rust-toolchain.toml",
      "**/Cross.toml",
    ],
    example: "crates/core/build.rs",
  },
  {
    tool: "GoReleaser",
    ecosystem: "Go",
    paths: ["**/.goreleaser.yml", "**/.goreleaser.yaml"],
    example: ".goreleaser.yaml",
  },
  {
    tool: "Mage",
    ecosystem: "Go",
    paths: ["**/magefile.go", "magefiles/**"],
    example: "magefile.go",
  },
  {
    tool: "Vite",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/vite.config.*"],
    example: "apps/web/vite.config.ts",
  },
  {
    tool: "webpack",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/webpack.config.*", "**/webpack.*.js"],
    example: "webpack.prod.js",
  },
  {
    tool: "Rollup",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/rollup.config.*"],
    example: "packages/core/rollup.config.mjs",
  },
  {
    tool: "esbuild",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/esbuild.config.*"],
    example: "esbuild.config.mjs",
  },
  {
    tool: "Parcel",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/.parcelrc"],
    example: ".parcelrc",
  },
  {
    tool: "Rspack/Rsbuild",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/rspack.config.*", "**/rsbuild.config.*"],
    example: "rsbuild.config.ts",
  },
  {
    tool: "tsup",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/tsup.config.*"],
    example: "packages/core/tsup.config.ts",
  },
  {
    tool: "SWC",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/.swcrc"],
    example: ".swcrc",
  },
  {
    tool: "Babel",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/babel.config.*", "**/.babelrc", "**/.babelrc.*"],
    example: "babel.config.js",
  },
  {
    tool: "TypeScript compiler",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/tsconfig.json", "**/tsconfig.*.json", "**/tsconfig-*.json"],
    example: "packages/core/tsconfig.build.json",
  },
  {
    tool: "Turborepo",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/turbo.json"],
    example: "turbo.json",
  },
  {
    tool: "Nx",
    ecosystem: "JavaScript/TypeScript",
    paths: ["nx.json"],
    example: "nx.json",
  },
  {
    tool: "Lerna",
    ecosystem: "JavaScript/TypeScript",
    paths: ["lerna.json"],
    example: "lerna.json",
  },
  {
    tool: "Gulp",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/gulpfile.*"],
    example: "gulpfile.js",
  },
  {
    tool: "Grunt",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/Gruntfile.*"],
    example: "Gruntfile.js",
  },
  {
    tool: "setuptools",
    ecosystem: "Python",
    paths: ["**/setup.py", "**/setup.cfg", "**/MANIFEST.in"],
    example: "libs/parser/setup.py",
  },
  {
    tool: "Hatch",
    ecosystem: "Python",
    paths: ["**/hatch.toml"],
    example: "hatch.toml",
  },
  {
    tool: "nox",
    ecosystem: "Python",
    paths: ["**/noxfile.py"],
    example: "noxfile.py",
  },
  {
    tool: "tox",
    ecosystem: "Python",
    paths: ["**/tox.ini"],
    example: "tox.ini",
  },
  {
    tool: "MSBuild",
    ecosystem: ".NET",
    paths: [
      "**/*.csproj",
      "**/*.fsproj",
      "**/*.vbproj",
      "**/*.sln",
      "**/Directory.Build.props",
      "**/Directory.Build.targets",
      "**/Directory.Packages.props",
      "global.json",
      "**/nuget.config",
      "**/NuGet.Config",
    ],
    example: "src/Api/Api.csproj",
  },
  {
    tool: "Cake",
    ecosystem: ".NET",
    paths: ["**/build.cake"],
    example: "build.cake",
  },
  {
    tool: "Make",
    ecosystem: "C/C++ and others",
    paths: ["**/Makefile", "**/GNUmakefile", "**/makefile", "**/*.mk"],
    example: "tools/Makefile",
  },
  {
    tool: "CMake",
    ecosystem: "C/C++",
    paths: ["**/CMakeLists.txt", "**/*.cmake", "**/CMakePresets.json"],
    example: "src/CMakeLists.txt",
  },
  {
    tool: "Meson",
    ecosystem: "C/C++",
    paths: ["**/meson.build", "**/meson_options.txt"],
    example: "meson.build",
  },
  {
    tool: "Ninja",
    ecosystem: "C/C++",
    paths: ["**/build.ninja"],
    example: "build.ninja",
  },
  {
    tool: "Autotools",
    ecosystem: "C/C++",
    paths: ["**/configure.ac", "**/Makefile.am", "**/Makefile.in"],
    example: "configure.ac",
  },
  {
    tool: "Conan",
    ecosystem: "C/C++",
    paths: ["**/conanfile.py", "**/conanfile.txt"],
    example: "conanfile.py",
  },
  {
    tool: "vcpkg",
    ecosystem: "C/C++",
    paths: ["**/vcpkg.json"],
    example: "vcpkg.json",
  },
  {
    tool: "Bazel or Pants",
    ecosystem: "Monorepo and polyglot",
    paths: ["**/BUILD", "**/BUILD.bazel"],
    example: "services/api/BUILD.bazel",
  },
  {
    tool: "Bazel",
    ecosystem: "Monorepo and polyglot",
    paths: [
      "WORKSPACE",
      "WORKSPACE.bazel",
      "WORKSPACE.bzlmod",
      "MODULE.bazel",
      "**/*.bzl",
      ".bazelrc",
      ".bazelversion",
    ],
    example: "MODULE.bazel",
  },
  {
    tool: "Buck2",
    ecosystem: "Monorepo and polyglot",
    paths: ["**/BUCK", ".buckconfig"],
    example: "libs/core/BUCK",
  },
  {
    tool: "Pants",
    ecosystem: "Monorepo and polyglot",
    paths: ["pants.toml"],
    example: "pants.toml",
  },
  {
    tool: "Earthly",
    ecosystem: "Monorepo and polyglot",
    paths: ["**/Earthfile"],
    example: "Earthfile",
  },
  {
    tool: "Nix",
    ecosystem: "Monorepo and polyglot",
    paths: ["**/flake.nix", "**/default.nix", "**/shell.nix"],
    example: "flake.nix",
  },
  {
    tool: "just",
    ecosystem: "Task runners",
    paths: ["**/justfile", "**/Justfile", "**/.justfile"],
    example: "justfile",
  },
  {
    tool: "Task",
    ecosystem: "Task runners",
    paths: ["**/Taskfile.yml", "**/Taskfile.yaml"],
    example: "Taskfile.yml",
  },
  {
    tool: "Rake",
    ecosystem: "Task runners",
    paths: ["**/Rakefile"],
    example: "Rakefile",
  },
  {
    tool: "Swift Package Manager",
    ecosystem: "Swift",
    paths: ["**/Package.swift"],
    example: "Package.swift",
  },
  {
    tool: "Mix",
    ecosystem: "Elixir",
    paths: ["**/mix.exs"],
    example: "apps/core/mix.exs",
  },
  {
    tool: "Cabal or Stack",
    ecosystem: "Haskell",
    paths: ["**/*.cabal", "**/stack.yaml"],
    example: "parser.cabal",
  },
  {
    tool: "build_runner",
    ecosystem: "Dart/Flutter",
    paths: ["**/build.yaml"],
    example: "build.yaml",
  },
];

/** The build tool whose globs match `path`, with the glob; or null. */
export const buildToolOf = compileTools(BUILD_TOOLS);
