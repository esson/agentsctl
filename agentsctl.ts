#!/usr/bin/env node
import { run } from "./src/cli.js";
import { providers, sessionSources } from "./src/providers/index.js";

run(process.argv.slice(2), { providers, sessionSources, now: () => new Date(), cwd: process.cwd() }, {
  isTTY: !!process.stdout.isTTY,
  env: process.env,
  columns: process.stdout.columns,
}).then(
  ({ stdout, stderr, exitCode }) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exitCode = exitCode;
  },
  (e: unknown) => {
    process.stderr.write(`agentsctl: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
