import path from "node:path";

/**
 * Comparable form of a folder path: no `\\?\` prefix (Codex stores some paths that way),
 * no trailing separator, and lowercase on Windows where paths are case-insensitive.
 */
export function normalizeFolder(p: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  const lib = win ? path.win32 : path.posix;
  let s = lib.normalize(win ? p.replace(/^\\\\\?\\/, "") : p);
  // Keep the separator of a root ("C:\", "/"), drop it everywhere else.
  if (s.length > lib.parse(s).root.length) s = s.replace(/[\\/]+$/, "");
  return win ? s.toLowerCase() : s;
}

/** True when both paths name exactly the same folder (no parent/child matching). */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeFolder(a, platform) === normalizeFolder(b, platform);
}
