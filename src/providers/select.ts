/**
 * Parse `--provider` ("Codex, claude") into the matching providers, in registry order.
 * Returns an error message for unknown or empty lists.
 */
export function selectProviders<T extends { name: string }>(
  spec: string,
  providers: T[],
): { ok: true; selected: T[] } | { ok: false; error: string } {
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
        `Known providers: ${[...new Set(providers.map((p) => p.name))].join(", ")}`,
    };
  }
  return { ok: true, selected: providers.filter((p) => names.includes(p.name)) };
}
