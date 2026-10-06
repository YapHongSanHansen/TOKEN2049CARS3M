import type { AgentEvent } from "./tools.js";

const short = (value: unknown, max = 220) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** One human-readable line per agent event (terminal and curl output). */
export function formatEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "run_started": return `\n▶ ${event.message}   [brain: ${event.brain}]\n`;
    case "assistant": return `🤖 ${event.text}`;
    case "tool_call": return `  → ${event.tool}(${short(event.input, 120)})`;
    case "tool_result": return `  ← ${event.tool}: ${short(event.result)}`;
    case "x402": return `     x402 ${event.step.padEnd(8)} ${short(event.detail, 160)}`;
    case "notify_user": return `🔔 ${event.message}`;
    case "run_finished": return `\n✔ ${event.summary}\n`;
    case "error": return `✖ ${event.message}`;
  }
}

export const printEvent = (event: AgentEvent) => { const line = formatEvent(event); if (line) console.log(line); };
