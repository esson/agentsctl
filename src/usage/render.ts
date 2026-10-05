import type { ProviderResult, UsageWindow } from "../providers/types.js";
import {
  bold,
  CRITICAL_AT,
  dim,
  errorColor,
  fg,
  FORECAST_CRITICAL_AT,
  FORECAST_WARN_AT,
  levelColor,
  PROVIDER_STYLES,
  stripAnsi,
  underline,
  WARN_AT,
} from "../theme.js";

// Pure rendering helpers. No provider knowledge, no I/O — easy to unit test.
// All times are rendered in the local timezone of the process.

const COLUMN_GAP = "   ";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const BAR_WIDTH = 20;
/** "100.0%" is the widest value; right-align to this so columns never shift. */
const PERCENT_WIDTH = 6;

const pad2 = (n: number): string => String(n).padStart(2, "0");

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}

export const PACE_MARKER = "│";

/** Cell index of the pace marker for `elapsed` percent of the window. */
function markerIndex(elapsed: number, width: number): number {
  return Math.min(width - 1, Math.floor((clampPercent(elapsed) / 100) * width));
}

/**
 * Bar filled in proportion to `percent` (the report passes percent USED). With `elapsed`
 * (percent of the window that has passed) one cell becomes a pace marker: fill short of the
 * marker = under pace, fill past it = ahead of pace.
 */
export function renderBar(percent: number, width = BAR_WIDTH, elapsed: number | null = null): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  if (elapsed === null) return bar;
  const m = markerIndex(elapsed, width);
  return bar.slice(0, m) + PACE_MARKER + bar.slice(m + 1);
}

/** Percent of the window that has passed, or null when the window start is unknown. */
export function elapsedPercent(w: UsageWindow, now: Date): number | null {
  if (!w.startsAt || !w.resetsAt) return null;
  const length = w.resetsAt.getTime() - w.startsAt.getTime();
  if (length <= 0) return null;
  return clampPercent(((now.getTime() - w.startsAt.getTime()) / length) * 100);
}

/** Too early in a window the linear forecast is noise (2 % used after 1 % of the time = "200 %"). */
const MIN_ELAPSED_FOR_FORECAST = 10;

/** Linear forecast of percent used at reset, or null when unknown or too early to say. */
export function projectedPercent(w: UsageWindow, now: Date): number | null {
  const elapsed = elapsedPercent(w, now);
  if (w.percentUsed === null || elapsed === null || elapsed < MIN_ELAPSED_FOR_FORECAST) return null;
  return (w.percentUsed / elapsed) * 100;
}

/**
 * Value that picks the color: current usage, raised to the warning/critical level when the
 * forecast says the limit will be (nearly) hit before the reset.
 */
export function severityPercent(w: UsageWindow, now: Date): number {
  const used = clampPercent(w.percentUsed ?? 0);
  const projected = projectedPercent(w, now);
  if (projected === null) return used;
  if (projected >= FORECAST_CRITICAL_AT) return Math.max(used, CRITICAL_AT);
  if (projected >= FORECAST_WARN_AT) return Math.max(used, WARN_AT);
  return used;
}

/** Fixed-width reset time, always with the date and the day padded: " 1 Oct 02:00", "29 Sep 21:37". */
export function formatReset(date: Date): string {
  const day = String(date.getDate()).padStart(2, " ");
  return `${day} ${MONTHS[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
const join = (a: string, b: string | null): string => (b ? `${a} and ${b}` : a);

/**
 * Time until `date`, two units at most: "3 days and 2 hours", "4 hours and 5 minutes",
 * "12 minutes". A zero second unit is left out ("3 days"). Past or now -> "now".
 */
export function formatRelative(date: Date, now: Date): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return "now";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return join(plural(d, "day"), h ? plural(h, "hour") : null);
  if (h > 0) return join(plural(h, "hour"), m ? plural(m, "minute") : null);
  return plural(m, "minute");
}

/** "resets in 3 days and 2 hours  27 Sep 19:00", with the relative part padded into a column. */
export function formatResetColumn(date: Date, now: Date): { relative: string; absolute: string } {
  const rel = formatRelative(date, now);
  return { relative: rel === "now" ? "resets now" : `resets in ${rel}`, absolute: formatReset(date) };
}

/** "2026-09-23 14:30" in local time. */
export function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export const REPORT_TITLE = "AI Usage Limits";
/** Nerd Font glyphs often render wider than one cell, so leave two spaces before the name. */
const GLYPH_GAP = "  ";
/** Window rows line up with the provider name: one cell for the glyph plus the gap. */
const INDENT = " ".repeat(1 + GLYPH_GAP.length);

export type Layout = "wide" | "compact";

export interface RenderOptions {
  /** ANSI colors and Nerd Font glyphs. Off by default (plain, script-friendly text). */
  color?: boolean;
  /** "wide": one line per window. "compact": stacked lines that fit `width`. Default "wide". */
  layout?: Layout;
  /** Terminal width in columns, used by the compact layout (default 60). */
  width?: number;
}

// Padding is always applied to plain strings before styling, so columns never shift.
interface Paint {
  level(percentUsed: number, s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  title(s: string): string;
  error(s: string): string;
  provider(name: string): string;
}

const PLAIN: Paint = {
  level: (_p, s) => s,
  dim: (s) => s,
  bold: (s) => s,
  title: (s) => s,
  error: (s) => s,
  provider: (name) => name,
};

const COLOR: Paint = {
  level: (p, s) => (s ? fg(levelColor(p), s) : s),
  dim: (s) => (s ? dim(s) : s),
  bold,
  title: (s) => bold(underline(s)),
  error: (s) => fg(errorColor, s),
  provider: (name) => {
    const style = PROVIDER_STYLES[name.toLowerCase()];
    if (!style) return bold(name);
    return bold(fg(style.color, style.glyph ? `${style.glyph}${GLYPH_GAP}${name}` : name));
  },
};

/** Bar colored by usage level: filled part in the level color, empty part dimmed. */
function paintBar(paint: Paint, used: number, width: number, severity: number, elapsed: number | null): string {
  const segment = (s: string): string => {
    const filled = s.replace(/░+$/, "");
    return paint.level(severity, filled) + paint.dim(s.slice(filled.length));
  };
  const bar = renderBar(used, width);
  if (elapsed === null) return segment(bar);
  const m = markerIndex(elapsed, width);
  return segment(bar.slice(0, m)) + paint.bold(PACE_MARKER) + segment(bar.slice(m + 1));
}

/** Label padded to `width` (on the plain text), with a trailing "(qualifier)" muted: "Monthly (Team)". */
function paintLabel(paint: Paint, label: string, width = 0): string {
  const padding = " ".repeat(Math.max(0, width - label.length));
  const m = /^(.*?)( \(.*\))$/.exec(label);
  return (m ? m[1] + paint.dim(m[2]) : label) + padding;
}

function percentText(used: number): string {
  return `${`${used.toFixed(1)}%`.padStart(PERCENT_WIDTH)} used`;
}

/** Widths of the padded wide-layout columns, sized to the widest value in the report. */
export interface Columns {
  label: number;
  relative: number;
}

function relativeText(w: UsageWindow, now: Date): string {
  return w.resetsAt ? formatResetColumn(w.resetsAt, now).relative : "";
}

/** Minimum column widths that fit every window in `results`. */
export function columnWidths(results: ProviderResult[], now: Date): Columns {
  const windows = results.flatMap((r) => (r.ok ? r.windows : []));
  return {
    label: Math.max(0, ...windows.map((w) => w.label.length)),
    relative: Math.max(0, ...windows.map((w) => relativeText(w, now).length)),
  };
}

export function renderWindow(w: UsageWindow, now: Date, opts: RenderOptions = {}, cols?: Columns): string {
  const paint = opts.color ? COLOR : PLAIN;
  const { label: labelWidth, relative: relativeWidth } = cols ?? columnWidths([{ provider: "", ok: true, windows: [w] }], now);
  let line: string;
  if (w.percentUsed === null) {
    // No limit to measure against: no bar, just the details.
    line = `${INDENT}${paintLabel(paint, w.label, labelWidth)}${COLUMN_GAP}${paint.dim(w.extra ?? "no limit")}`;
  } else {
    const used = clampPercent(w.percentUsed);
    const severity = severityPercent(w, now);
    const elapsed = elapsedPercent(w, now);
    line = `${INDENT}${paintLabel(paint, w.label, labelWidth)}${COLUMN_GAP}${paintBar(paint, used, BAR_WIDTH, severity, elapsed)}  ${paint.level(severity, percentText(used))}`;
  }
  // Columns: reset (relative, padded) + reset (absolute), then details last so they never
  // push the reset columns out of line.
  if (w.resetsAt) {
    const { relative, absolute } = formatResetColumn(w.resetsAt, now);
    line += paint.dim(`   ${relative.padEnd(relativeWidth)}  ${absolute}`);
  }
  if (w.percentUsed !== null && w.extra) line += paint.dim(`   (${w.extra})`);
  return line;
}

const MIN_BAR_WIDTH = 10;

/**
 * Stacked window for narrow terminals:
 *   Weekly
 *   ███████████████░░░░░░░░░░░░░░░    76.0% used
 *   Resets in 3 days and 9 hours · 27 Sep 18:59
 *   12,350/19,000, you 4,120
 */
export function renderWindowCompact(w: UsageWindow, now: Date, opts: RenderOptions = {}): string[] {
  const paint = opts.color ? COLOR : PLAIN;
  const lines = [`${INDENT}${paintLabel(paint, w.label)}`];
  if (w.percentUsed === null) {
    lines.push(`${INDENT}${paint.dim(w.extra ?? "no limit")}`);
  } else {
    const used = clampPercent(w.percentUsed);
    const pct = percentText(used);
    const barWidth = Math.max(MIN_BAR_WIDTH, (opts.width ?? 60) - INDENT.length - pct.length - 2);
    const severity = severityPercent(w, now);
    lines.push(`${INDENT}${paintBar(paint, used, barWidth, severity, elapsedPercent(w, now))}  ${paint.level(severity, pct)}`);
  }
  if (w.resetsAt) {
    const { relative, absolute } = formatResetColumn(w.resetsAt, now);
    const text = relative.charAt(0).toUpperCase() + relative.slice(1);
    lines.push(`${INDENT}${paint.dim(`${text} · ${absolute.trim()}`)}`);
  }
  if (w.percentUsed !== null && w.extra) lines.push(`${INDENT}${paint.dim(w.extra)}`);
  return lines;
}

/** Full human-readable report, with one empty line of padding above and below. */
export function renderReport(results: ProviderResult[], now: Date, opts: RenderOptions = {}): string {
  const paint = opts.color ? COLOR : PLAIN;
  const compact = opts.layout === "compact";
  const cols = columnWidths(results, now);
  const lines: string[] = ["", `${paint.title(REPORT_TITLE)} ${paint.dim(`— ${formatTimestamp(now)}`)}`];
  for (const r of results) {
    lines.push("", paint.provider(r.provider));
    if (compact) lines.push(""); // stacked layout: breathing room under the tool name
    if (!r.ok) {
      lines.push(`${INDENT}${paint.error("could not read:")} ${r.error}`);
    } else if (r.windows.length === 0) {
      lines.push(`${INDENT}no usage data`);
    } else if (compact) {
      r.windows.forEach((w, i) => {
        if (i > 0) lines.push("");
        lines.push(...renderWindowCompact(w, now, opts));
      });
    } else {
      for (const w of r.windows) lines.push(renderWindow(w, now, opts, cols));
    }
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

/** Width in columns of the widest line (ANSI codes ignored). */
export function reportWidth(report: string): number {
  return Math.max(0, ...stripAnsi(report).split("\n").map((l) => [...l].length));
}

/**
 * Wide layout if it fits `columns` (or the width is unknown, e.g. a pipe), otherwise compact.
 */
export function renderReportAuto(results: ProviderResult[], now: Date, opts: RenderOptions & { columns?: number }): string {
  const wide = renderReport(results, now, { ...opts, layout: "wide" });
  if (opts.columns === undefined || reportWidth(wide) <= opts.columns) return wide;
  return renderReport(results, now, { ...opts, layout: "compact", width: opts.columns });
}

export type JsonWindow = Omit<UsageWindow, "resetsAt" | "startsAt"> & { resetsAt: string | null; startsAt?: string };
export type JsonResult =
  | { provider: string; ok: true; windows: JsonWindow[] }
  | { provider: string; ok: false; error: string };

/** Plain JSON-serialisable data (dates as ISO strings). */
export function toJsonResults(results: ProviderResult[]): JsonResult[] {
  return results.map((r) =>
    r.ok
      ? {
          provider: r.provider,
          ok: true,
          windows: r.windows.map((w) => ({
            label: w.label,
            percentUsed: w.percentUsed,
            resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
            ...(w.startsAt ? { startsAt: w.startsAt.toISOString() } : {}),
            ...(w.extra !== undefined ? { extra: w.extra } : {}),
          })),
        }
      : { provider: r.provider, ok: false, error: r.error },
  );
}

export function renderJson(results: ProviderResult[]): string {
  return JSON.stringify(toJsonResults(results), null, 2) + "\n";
}
