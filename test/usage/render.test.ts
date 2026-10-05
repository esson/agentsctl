import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRelative,
  formatReset,
  formatTimestamp,
  renderBar,
  renderJson,
  renderReport,
  renderReportAuto,
  renderWindow,
  renderWindowCompact,
  columnWidths,
  elapsedPercent,
  projectedPercent,
  severityPercent,
  reportWidth,
} from "../../src/usage/render.js";
import type { ProviderResult } from "../../src/providers/types.js";
import { levelColor, PROVIDER_STYLES, stripAnsi } from "../../src/theme.js";

// All dates are built in local time so the tests are timezone independent.
const now = new Date(2026, 8, 23, 14, 30); // 2026-09-23 14:30

test("renderBar: fills proportionally to the given percent", () => {
  assert.equal(renderBar(25), "█████░░░░░░░░░░░░░░░");
  assert.equal(renderBar(100), "█".repeat(20));
  assert.equal(renderBar(0), "░".repeat(20));
  assert.equal(renderBar(50, 10), "█████░░░░░");
});

test("renderBar: clamps out-of-range and NaN values", () => {
  assert.equal(renderBar(150), "█".repeat(20));
  assert.equal(renderBar(-10), "░".repeat(20));
  assert.equal(renderBar(Number.NaN), "░".repeat(20));
});

test("formatReset: always date + time, day padded with a space (fixed width)", () => {
  assert.equal(formatReset(new Date(2026, 8, 23, 16, 59)), "23 Sep 16:59");
  assert.equal(formatReset(new Date(2026, 8, 23, 9, 5)), "23 Sep 09:05");
  assert.equal(formatReset(new Date(2026, 9, 1, 0, 0)), " 1 Oct 00:00");
  assert.equal(formatReset(new Date(2026, 9, 1, 2, 0)).length, 12);
});

test("formatTimestamp", () => {
  assert.equal(formatTimestamp(now), "2026-09-23 14:30");
});

const sample: ProviderResult[] = [
  {
    provider: "Codex",
    ok: true,
    windows: [
      { label: "Session (5h)", percentUsed: 75, resetsAt: new Date(2026, 8, 23, 16, 59) },
      { label: "Weekly", percentUsed: 12, resetsAt: new Date(2026, 8, 29, 21, 37) },
    ],
  },
  {
    provider: "Copilot",
    ok: true,
    windows: [
      { label: "Monthly (Premium)", percentUsed: 27, resetsAt: new Date(2026, 9, 1), extra: "142/300" },
      { label: "Chat", percentUsed: 0, resetsAt: null },
    ],
  },
  { provider: "Cursor", ok: false, error: "no session found in state.vscdb" },
];

test("renderReport: full text report", () => {
  const expected = [
    "",
    "AI Usage Limits — 2026-09-23 14:30",
    "",
    "Codex",
    "   Session (5h)        ███████████████░░░░░   75.0% used   resets in 2 hours and 29 minutes  23 Sep 16:59",
    "   Weekly              ██░░░░░░░░░░░░░░░░░░   12.0% used   resets in 6 days and 7 hours      29 Sep 21:37",
    "",
    "Copilot",
    "   Monthly (Premium)   █████░░░░░░░░░░░░░░░   27.0% used   resets in 7 days and 9 hours       1 Oct 00:00   (142/300)",
    "   Chat                ░░░░░░░░░░░░░░░░░░░░    0.0% used",
    "",
    "Cursor",
    "   could not read: no session found in state.vscdb",
    "",
    "",
  ].join("\n");
  assert.equal(renderReport(sample, now), expected);
});

test("renderReport: ok provider with no windows", () => {
  const out = renderReport([{ provider: "Claude", ok: true, windows: [] }], now);
  assert.match(out, /Claude\n {3}no usage data\n\n$/);
});

test("renderJson: dates as ISO strings, errors preserved", () => {
  const parsed = JSON.parse(renderJson(sample));
  assert.deepEqual(parsed, [
    {
      provider: "Codex",
      ok: true,
      windows: [
        { label: "Session (5h)", percentUsed: 75, resetsAt: new Date(2026, 8, 23, 16, 59).toISOString() },
        { label: "Weekly", percentUsed: 12, resetsAt: new Date(2026, 8, 29, 21, 37).toISOString() },
      ],
    },
    {
      provider: "Copilot",
      ok: true,
      windows: [
        { label: "Monthly (Premium)", percentUsed: 27, resetsAt: new Date(2026, 9, 1).toISOString(), extra: "142/300" },
        { label: "Chat", percentUsed: 0, resetsAt: null },
      ],
    },
    { provider: "Cursor", ok: false, error: "no session found in state.vscdb" },
  ]);
});

test("renderWindow: null percentUsed renders details without a bar", () => {
  const line = renderWindow({ label: "Monthly (You)", percentUsed: null, resetsAt: null, extra: "4,120 used" }, new Date(2026, 8, 23, 14, 30));
  assert.equal(line.trim(), "Monthly (You)   4,120 used");
  assert.ok(!line.includes("█") && !line.includes("░"));
});

// ---- colors ----

const truecolor = ([r, g, b]: readonly [number, number, number]) => `[38;2;${r};${g};${b}m`;

test("renderReport color: glyphs and provider colors for every provider", () => {
  const out = renderReport(sample, now, { color: true });
  assert.ok(out.includes(truecolor(PROVIDER_STYLES.codex.color) + "  Codex"));
  assert.ok(out.includes(truecolor(PROVIDER_STYLES.copilot.color) + "  Copilot"));
  assert.ok(out.includes(truecolor(PROVIDER_STYLES.cursor.color) + "  Cursor"));
});

test("renderReport color: stripping ANSI gives the plain report plus glyphs (alignment unchanged)", () => {
  const plain = renderReport(sample, now);
  const colored = stripAnsi(renderReport(sample, now, { color: true }))
    .replace("  Codex", "Codex")
    .replace("  Copilot", "Copilot");
  assert.equal(colored.replace("  Cursor", "Cursor"), plain);
});

test("levelColor thresholds: green < 75 <= yellow < 90 <= red", () => {
  assert.deepEqual(levelColor(74.9), levelColor(0));
  assert.notDeepEqual(levelColor(75), levelColor(74.9));
  assert.deepEqual(levelColor(89.9), levelColor(75));
  assert.notDeepEqual(levelColor(90), levelColor(89.9));
  assert.deepEqual(levelColor(100), levelColor(90));
});

test("renderWindow color: bar and percent use the usage-level color", () => {
  const line = renderWindow({ label: "Weekly", percentUsed: 95, resetsAt: null }, now, { color: true });
  assert.ok(line.includes(truecolor(levelColor(95)) + "█".repeat(19)));
  assert.ok(line.includes(truecolor(levelColor(95)) + " 95.0% used"));
});

test("formatRelative: two units at most, singular/plural, zero units dropped", () => {
  const at = (d: number, h: number, m: number) => new Date(now.getTime() + ((d * 24 + h) * 60 + m) * 60000);
  assert.equal(formatRelative(at(3, 2, 0), now), "3 days and 2 hours");
  assert.equal(formatRelative(at(3, 0, 40), now), "3 days");
  assert.equal(formatRelative(at(1, 1, 0), now), "1 day and 1 hour");
  assert.equal(formatRelative(at(0, 4, 5), now), "4 hours and 5 minutes");
  assert.equal(formatRelative(at(0, 5, 0), now), "5 hours");
  assert.equal(formatRelative(at(0, 0, 1), now), "1 minute");
  assert.equal(formatRelative(at(0, 0, 0), now), "now");
  assert.equal(formatRelative(new Date(now.getTime() - 60000), now), "now");
});

// ---- compact layout ----

test("renderWindowCompact: label, full-width bar + percent, reset line, details", () => {
  const w = { label: "Monthly (Team)", percentUsed: 50, resetsAt: new Date(2026, 9, 1, 2, 0), extra: "9,500/19,000" };
  const lines = renderWindowCompact(w, now, { width: 40 });
  assert.deepEqual(lines, [
    "   Monthly (Team)",
    `   ${"█".repeat(12)}${"░".repeat(12)}   50.0% used`,
    "   Resets in 7 days and 11 hours · 1 Oct 02:00",
    "   9,500/19,000",
  ]);
  assert.equal(lines[1].length, 40, "bar line fills the width");
});

test("renderWindowCompact: bar never narrower than 10", () => {
  const [, bar] = renderWindowCompact({ label: "x", percentUsed: 0, resetsAt: null }, now, { width: 5 });
  assert.ok(bar.includes("░".repeat(10)));
});

test("renderReport compact: padding, title, windows separated by blank lines", () => {
  const out = renderReport(sample, now, { layout: "compact", width: 50 });
  const lines = out.split("\n");
  assert.equal(lines[0], "");
  assert.equal(lines[1], "AI Usage Limits — 2026-09-23 14:30");
  assert.ok(out.endsWith("\n\n"));
  assert.ok(out.includes("Codex\n\n   Session (5h)\n"), "empty line under the tool name");
  assert.ok(out.includes("Cursor\n\n   could not read:"));
  assert.ok(out.includes("23 Sep 16:59\n\n   Weekly\n"));
  assert.ok(out.includes("   could not read: no session found in state.vscdb"));
  assert.ok(reportWidth(out) <= 50);
});

test("renderReportAuto: wide when it fits or width unknown, compact otherwise", () => {
  const wide = renderReport(sample, now);
  const w = reportWidth(wide);
  assert.equal(renderReportAuto(sample, now, {}), wide);
  assert.equal(renderReportAuto(sample, now, { columns: w }), wide);
  assert.equal(renderReportAuto(sample, now, { columns: w - 1 }), renderReport(sample, now, { layout: "compact", width: w - 1 }));
});

test("renderReport color: title is underlined", () => {
  assert.ok(renderReport(sample, now, { color: true }).includes("\x1b[4mAI Usage Limits"));
});

test("renderWindow color: label qualifier in parentheses is muted, column width unchanged", () => {
  const w = { label: "Monthly (Team)", percentUsed: 50, resetsAt: null };
  const colored = renderWindow(w, now, { color: true });
  assert.ok(colored.includes("Monthly\x1b[2m (Team)\x1b[0m"));
  assert.equal(stripAnsi(colored), renderWindow(w, now));
  assert.ok(renderWindowCompact(w, now, { color: true })[0].includes("Monthly\x1b[2m (Team)\x1b[0m"));
});

test("columnWidths: sized to the widest label and relative reset text in the report", () => {
  assert.deepEqual(columnWidths(sample, now), {
    label: "Monthly (Premium)".length,
    relative: "resets in 2 hours and 29 minutes".length,
  });
  assert.deepEqual(columnWidths([], now), { label: 0, relative: 0 });
});

// ---- pace marker and forecast color ----

// A weekly window that started `elapsedDays` ago (relative to `now`).
const weekly = (percentUsed: number, elapsedDays: number) => {
  const startsAt = new Date(now.getTime() - elapsedDays * 86400000);
  return { label: "Weekly", percentUsed, startsAt, resetsAt: new Date(startsAt.getTime() + 7 * 86400000) };
};

test("renderBar: pace marker replaces the cell at the elapsed position", () => {
  assert.equal(renderBar(25, 20, 50), "█████░░░░░│░░░░░░░░░", "under pace: fill stops before the marker");
  assert.equal(renderBar(75, 20, 50), "██████████│████░░░░░", "ahead of pace: fill passes the marker");
  assert.equal(renderBar(0, 20, 0), "│░░░░░░░░░░░░░░░░░░░");
  assert.equal(renderBar(100, 20, 100), "███████████████████│", "marker stays inside the bar");
  assert.equal(renderBar(25, 20, null), renderBar(25, 20), "no marker without elapsed");
});

test("elapsedPercent: share of the window that has passed; null without a start", () => {
  assert.equal(elapsedPercent(weekly(10, 3.5), now), 50);
  assert.equal(elapsedPercent({ label: "x", percentUsed: 10, resetsAt: new Date(now.getTime() + 1000) }, now), null);
  assert.equal(elapsedPercent({ label: "x", percentUsed: 10, resetsAt: null, startsAt: now }, now), null);
});

test("projectedPercent: linear forecast at reset, hidden early in the window", () => {
  assert.equal(projectedPercent(weekly(40, 1.75), now), 160); // 40 % used after 25 % of the time
  assert.equal(projectedPercent(weekly(2, 0.07), now), null, "under 10 % elapsed is noise");
  assert.equal(projectedPercent({ label: "x", percentUsed: null, resetsAt: null }, now), null);
});

test("severityPercent: forecast raises the color level, never lowers it", () => {
  assert.equal(severityPercent(weekly(40, 1.75), now), 90, "on course to exceed 100 % -> critical");
  assert.equal(severityPercent(weekly(22, 1.75), now), 75, "forecast 88 % -> warning");
  assert.equal(severityPercent(weekly(10, 3.5), now), 10, "forecast 20 % -> plain usage");
  assert.equal(severityPercent(weekly(95, 6.9), now), 95, "high usage stays critical even if the forecast is under 100");
  assert.equal(severityPercent({ label: "x", percentUsed: 40, resetsAt: null }, now), 40, "no window start -> usage only");
});

test("renderWindow: marker in the plain bar; color follows the forecast", () => {
  const ahead = weekly(40, 1.75);
  assert.ok(renderWindow(ahead, now).includes("█████│██░░░░░░░░░░░░"));
  const colored = renderWindow(ahead, now, { color: true });
  assert.ok(colored.includes(truecolor(levelColor(90))), "red although only 40 % is used");
  assert.equal(stripAnsi(colored), renderWindow(ahead, now));
  const under = renderWindow(weekly(10, 3.5), now, { color: true });
  assert.ok(under.includes(truecolor(levelColor(0))) && !under.includes(truecolor(levelColor(90))));
});

test("renderWindowCompact: marker scales with the bar width", () => {
  const [, bar] = renderWindowCompact(weekly(10, 3.5), now, { width: 55 });
  const cells = bar.trim().split("  ")[0];
  assert.equal([...cells].indexOf("│"), Math.floor([...cells].length / 2));
});

test("renderJson: startsAt is included when known", () => {
  const w = weekly(10, 3.5);
  const [r] = JSON.parse(renderJson([{ provider: "X", ok: true, windows: [w] }]));
  assert.equal(r.windows[0].startsAt, w.startsAt.toISOString());
  const [plain] = JSON.parse(renderJson([{ provider: "X", ok: true, windows: [{ label: "a", percentUsed: 1, resetsAt: null }] }]));
  assert.ok(!("startsAt" in plain.windows[0]));
});
