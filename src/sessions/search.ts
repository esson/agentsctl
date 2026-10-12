import { stripLongPathPrefix } from "./folders.js";
import { clientLabel, type ListedSession } from "./render.js";

// `sessions --search`: a session matches when every word of the query occurs, case-insensitive,
// somewhere in what the list shows or what identifies it.

/** The words of a search; empty when the query is only spaces. */
export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Title, folder, id, agent, client, branch and model, lowercased, for matching. */
function searchable({ provider, session: s }: ListedSession): string {
  return [s.title ?? "", stripLongPathPrefix(s.cwd), s.id, provider, clientLabel(s), s.branch ?? "", s.model ?? ""]
    .join("\n")
    .toLowerCase();
}

export function matchesSearch(l: ListedSession, words: string[]): boolean {
  const text = searchable(l);
  return words.every((w) => text.includes(w));
}
