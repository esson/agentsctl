import { parseArgs } from "node:util";
import type { CollectOptions, Provider, ProviderResult } from "../providers/types.js";
import { errorMessage } from "../providers/util.js";
import { EXIT_OK, EXIT_USAGE, type RunResult } from "../result.js";
import { NO_TERMINAL, useColor, type Terminal } from "../terminal.js";
import { renderJson, renderReport, renderReportAuto } from "./render.js";

// The `usage` subcommand: argv + providers + clock in, text + exit code out.

export const EXIT_ALL_FAILED = 1;

export function helpText(providers: Provider[]): string {
  return `agentsctl usage — show subscription usage for AI tools

Usage: agentsctl usage [options]

Options:
  --json                 Print machine-readable JSON instead of the report
  --provider <names>     Providers, separated by commas or spaces (${providers.map((p) => p.name).join(", ")})
  --no-refresh           Never refresh expired tokens or write to credential files (strictly read-only)
  --no-color             Plain text: no colors or icons (also: NO_COLOR env var; FORCE_COLOR forces color)
  --layout <mode>        auto (default: wide if it fits the terminal, else compact), wide, or compact
  -h, --help             Show this help

By default an expired token (or a 401) triggers one OAuth refresh for Codex, Claude and Cursor,
and the new tokens are written back to that tool's credential store so the tool stays logged in.

Exit codes: 0 = at least one provider returned data, 1 = all failed, 2 = usage error.
`;
}

/** Run one provider; a throw becomes an error result so it never affects the others. */
async function runProvider(p: Provider, opts: CollectOptions): Promise<ProviderResult> {
  try {
    return await p.collect(opts);
  } catch (e) {
    return { provider: p.displayName ?? p.name, ok: false, error: errorMessage(e) };
  }
}

/**
 * Parse `--provider` ("Codex, claude") into the matching providers, in registry order.
 * Returns an error message for unknown or empty lists.
 */
export function selectProviders(
  spec: string,
  providers: Provider[],
): { ok: true; selected: Provider[] } | { ok: false; error: string } {
  const names = spec
    // Commas or whitespace: PowerShell turns an unquoted a,b,c into an array that npm's
    // .ps1 shim passes on as one space-separated argument ("a b c").
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((n) => !providers.some((p) => p.name === n));
  if (unknown.length > 0 || names.length === 0) {
    return {
      ok: false,
      error:
        `unknown provider: ${unknown.join(", ") || "(none given)"}. ` +
        `Known providers: ${providers.map((p) => p.name).join(", ")}`,
    };
  }
  return { ok: true, selected: providers.filter((p) => names.includes(p.name)) };
}

export async function runUsage(
  argv: string[],
  providers: Provider[],
  now: () => Date = () => new Date(),
  term: Terminal = NO_TERMINAL,
): Promise<RunResult> {
  let values: {
    json?: boolean;
    provider?: string;
    help?: boolean;
    "no-refresh"?: boolean;
    "no-color"?: boolean;
    layout?: string;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        provider: { type: "string" },
        "no-refresh": { type: "boolean" },
        "no-color": { type: "boolean" },
        layout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    return { stdout: "", stderr: `agentsctl usage: ${errorMessage(e)}\n\n${helpText(providers)}`, exitCode: EXIT_USAGE };
  }

  if (values.help) return { stdout: helpText(providers), stderr: "", exitCode: EXIT_OK };

  const layout = values.layout ?? "auto";
  if (!["auto", "wide", "compact"].includes(layout)) {
    return { stdout: "", stderr: `agentsctl usage: --layout must be auto, wide or compact
`, exitCode: EXIT_USAGE };
  }

  let selected = providers;
  if (values.provider !== undefined) {
    const sel = selectProviders(values.provider, providers);
    if (!sel.ok) return { stdout: "", stderr: `agentsctl usage: ${sel.error}\n`, exitCode: EXIT_USAGE };
    selected = sel.selected;
  }

  const opts: CollectOptions = { refresh: !values["no-refresh"] };
  const results = await Promise.all(selected.map((p) => runProvider(p, opts)));
  const color = useColor(!!values["no-color"], term);
  const columns = term.isTTY ? term.columns : undefined;
  let stdout: string;
  if (values.json) stdout = renderJson(results);
  else if (layout === "auto") stdout = renderReportAuto(results, now(), { color, columns });
  else stdout = renderReport(results, now(), { color, layout: layout as "wide" | "compact", width: columns });
  return { stdout, stderr: "", exitCode: results.some((r) => r.ok) ? EXIT_OK : EXIT_ALL_FAILED };
}
