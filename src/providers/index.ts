import type { Provider } from "./types.js";
import { codex } from "./codex/usage.js";
import { claude } from "./claude/usage.js";
import { copilot } from "./copilot/usage.js";
import { cursor } from "./cursor/usage.js";

/** All known providers, in report order. Add a new provider here. */
export const providers: Provider[] = [codex, claude, copilot, cursor];
