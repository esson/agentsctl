#!/usr/bin/env node
import { run } from "./src/cli.js";
import { page } from "./src/pager.js";
import { providers, sessionSources } from "./src/providers/index.js";

run(process.argv.slice(2), { providers, sessionSources, now: () => new Date(), cwd: process.cwd() }, {
  isTTY: !!process.stdout.isTTY,
  env: process.env,
  columns: process.stdout.columns,
}).then(
  async ({ stdout, stderr, exitCode, page: pageable }) => {
    // Like git: only page when writing to a terminal; piped output is never paged.
    const paged = stdout && pageable && process.stdout.isTTY ? await page(stdout) : "off";
    if (paged === "failed") process.stderr.write("agentsctl: could not start a pager (install less or set PAGER)\n");
    if (stdout && paged !== "paged") process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exitCode = exitCode;
  },
  (e: unknown) => {
    process.stderr.write(`agentsctl: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
