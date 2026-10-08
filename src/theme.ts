// Colors and Nerd Font glyphs for the text report. Pure helpers, no I/O.
// Adjust provider colors/glyphs here; bars are colored by usage level, not by provider.

export type Rgb = readonly [number, number, number];

export interface ProviderStyle {
  /** Nerd Font glyph, shown before the provider name. */
  glyph?: string;
  color: Rgb;
}

/** Keyed by lowercased display name ("Codex" -> "codex"). */
export const PROVIDER_STYLES: Record<string, ProviderStyle> = {
  codex: { glyph: "", color: [0x10, 0xa3, 0x7f] }, // OpenAI green
  claude: { glyph: "", color: [0xd9, 0x77, 0x57] }, // Claude orange
  copilot: { glyph: "", color: [0x89, 0x57, 0xe5] }, // Copilot purple
  // No Cursor logo in Nerd Fonts; cod-cursor (pointer) from the same Codicons set as the others.
  cursor: { glyph: "", color: [0xe6, 0xe6, 0xe6] },
};

const GREEN: Rgb = [0x4e, 0xc9, 0x6b];
const YELLOW: Rgb = [0xe5, 0xc0, 0x4b];
const RED: Rgb = [0xe5, 0x53, 0x4b];

export const WARN_AT = 75;
export const CRITICAL_AT = 90;
/** Forecast at reset (linear pace): yellow from 85 %, red from 100 % (on course to hit the limit). */
export const FORECAST_WARN_AT = 85;
export const FORECAST_CRITICAL_AT = 100;

/** Usage-level color: green below 75 %, yellow from 75 %, red from 90 %. */
export function levelColor(percentUsed: number): Rgb {
  if (percentUsed >= CRITICAL_AT) return RED;
  if (percentUsed >= WARN_AT) return YELLOW;
  return GREEN;
}

export const errorColor: Rgb = RED;

const RESET = "\x1b[0m";

export const fg = (rgb: Rgb, s: string): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}`;
export const bold = (s: string): string => `\x1b[1m${s}${RESET}`;
export const dim = (s: string): string => `\x1b[2m${s}${RESET}`;
export const underline = (s: string): string => `\x1b[4m${s}${RESET}`;

/** Nerd Font glyphs often render wider than one cell, so leave two spaces before the name. */
export const GLYPH_GAP = "  ";

/** Provider name in bold, in its own color and with its glyph when it has a style. */
export function paintProvider(name: string): string {
  const style = PROVIDER_STYLES[name.toLowerCase()];
  if (!style) return bold(name);
  return bold(fg(style.color, style.glyph ? `${style.glyph}${GLYPH_GAP}${name}` : name));
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
