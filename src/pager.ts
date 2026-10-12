import { spawn } from "node:child_process";
import path from "node:path";

// Showing output through a pager, like `git log`. Process I/O, so only agentsctl.ts uses it;
// commands just mark their result as pageable (RunResult.page).

/** less: treat the private use areas, where Nerd Font glyphs live, as printable one-cell characters. */
export const NERD_FONT_CHARS = "e000-f8ff:p,f0000-10fffd:p";

/** One way to start a pager: a user-given command line (run by the shell) or an executable. */
export type PagerCandidate = { shell: string } | { file: string };

/**
 * Pagers to try in order: $AGENTSCTL_PAGER or $PAGER when set (empty or "cat" = no pager),
 * else `less`, and on Windows the `less` that comes with Git for Windows.
 */
export function pagerCandidates(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): PagerCandidate[] {
  const chosen = env.AGENTSCTL_PAGER ?? env.PAGER;
  if (chosen !== undefined) return chosen.trim() === "" || chosen.trim() === "cat" ? [] : [{ shell: chosen }];
  const list: PagerCandidate[] = [{ file: "less" }];
  if (platform === "win32") {
    list.push({ file: path.win32.join(env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "less.exe") });
  }
  return list;
}

/**
 * Feed `text` to the pager and wait until it is closed. False when it could not be started or
 * failed (a mistyped $PAGER still starts the shell, which then exits non-zero).
 */
function runPager(c: PagerCandidate, text: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child =
      "shell" in c
        ? spawn(c.shell, { shell: true, stdio: ["pipe", "inherit", "inherit"], env })
        : spawn(c.file, [], { stdio: ["pipe", "inherit", "inherit"], env });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {}); // EPIPE when the pager is quit before reading everything
    child.stdin.end(text);
  });
}

/**
 * Show `text` in the first pager that starts. `less` gets LESS=FRX unless LESS is set, as with git:
 * quit when it fits on one screen, keep colors, leave the text on screen. It also gets
 * LESSUTFCHARDEF (unless set) so the Nerd Font glyphs, which are in the Unicode private use areas,
 * are printed instead of shown as <U+EC82>.
 * "off" when paging is turned off ($PAGER=cat) and "failed" when no pager could be started;
 * the caller then prints the text itself.
 */
export async function page(text: string, env: NodeJS.ProcessEnv = process.env): Promise<"paged" | "off" | "failed"> {
  const candidates = pagerCandidates(env);
  if (candidates.length === 0) return "off";
  const pagerEnv = { ...env, LESS: env.LESS ?? "FRX", LESSUTFCHARDEF: env.LESSUTFCHARDEF ?? NERD_FONT_CHARS };
  // Ctrl+C belongs to the pager (less uses it to stop a search), so it must not end agentsctl.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    for (const c of candidates) {
      if (await runPager(c, text, pagerEnv)) return "paged";
    }
    return "failed";
  } finally {
    process.off("SIGINT", ignore);
  }
}
