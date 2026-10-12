import type { SessionSource } from "../sessions/types.js";
import type { Provider } from "./types.js";
import { codex } from "./codex/usage.js";
import { claude } from "./claude/usage.js";
import { copilot } from "./copilot/usage.js";
import { cursor } from "./cursor/usage.js";
import { codexSessions } from "./codex/sessions.js";
import { claudeSessions } from "./claude/sessions.js";
import { copilotSessions } from "./copilot/sessions.js";
import { visualStudioSessions } from "./copilot/visualstudio.js";
import { cursorSessions } from "./cursor/sessions.js";

/** All known providers, in report order. Add a new provider here. */
export const providers: Provider[] = [codex, claude, copilot, cursor];

/** Agents whose saved sessions `agentsctl sessions` can list. Sources may share a name. */
export const sessionSources: SessionSource[] = [
  codexSessions,
  claudeSessions,
  copilotSessions,
  visualStudioSessions, // Copilot Chat in Visual Studio; selected with --provider copilot too
  cursorSessions,
];
