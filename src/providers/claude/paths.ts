import os from "node:os";
import path from "node:path";

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR, default ~/.claude. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}
