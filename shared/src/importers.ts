/**
 * Readers for chat exports. They only extract the user's own messages; the
 * caller redacts them before storing (or, for the local sync helper, before
 * anything leaves the machine).
 */

/** ChatGPT → Settings → Data controls → Export: conversations.json */
export function userMessagesFromChatGptExport(json: unknown): string[] {
  const conversations = Array.isArray(json) ? json as Array<{ mapping?: Record<string, { message?: { author?: { role?: string }; content?: { parts?: unknown[] }; create_time?: number } }> }> : [];
  return conversations.flatMap(c => Object.values(c.mapping ?? {}))
    .filter(node => node.message?.author?.role === "user")
    .sort((a, b) => (b.message?.create_time ?? 0) - (a.message?.create_time ?? 0))
    .map(node => (node.message?.content?.parts ?? []).filter(part => typeof part === "string").join(" "));
}

/** Claude → Settings → Privacy → Export data: conversations.json */
export function userMessagesFromClaudeExport(json: unknown): string[] {
  const conversations = Array.isArray(json) ? json as Array<{ chat_messages?: Array<{ sender?: string; text?: string; created_at?: string }> }> : [];
  return conversations.flatMap(c => c.chat_messages ?? [])
    .filter(m => m.sender === "human" && m.text)
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))
    .map(m => m.text!);
}

/** The example chats from the CARSEM drawing, for the demo. */
export const SAMPLE_CHATS = [
  "Cheapest flight from Kuala Lumpur to Singapore next weekend",
  "Cheapest Pokemon Pack 30th Anniversary",
  "Cheapest hotel at Singapore Geylang for 2 nights",
  "My girlfriend's birthday is on 30th Sept, what should I buy? Budget around RM 300",
  "Find me the information of trading signals, I want some extra pocket money on Cardano DEX trades",
  "Looking for a new laptop for design work under RM 6000",
  "Planning to move to a condo near KLCC next year, what is the rent like?",
];
