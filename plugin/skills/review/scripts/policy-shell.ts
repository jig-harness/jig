#!/usr/bin/env bun
/** Execute the trusted snapshot's configured command using Bun's portable shell. */
import { $ } from "bun";
import { Defect } from "../../../shared/errors.ts";
const command = process.argv[2];
if (!command) throw new Defect("policy command is required");
const result = await $`${{ raw: command }}`.env(process.env).nothrow().quiet();
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
