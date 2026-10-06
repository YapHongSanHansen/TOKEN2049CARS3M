import type { AgentEvent } from "./tools.js";

const short = (value: unknown, max = 220) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Human-readable activity log line for the terminal. */
export function printEvent(event: AgentEvent) {
  switch (event.type) {
    case "run_started": console.log(`\n▶ ${event.message}   [brain: ${event.brain}]\n`); break;
    case "assistant": console.log(`🤖 ${event.text}`); break;
    case "tool_call": console.log(`  → ${event.tool}(${short(event.input, 120)})`); break;
    case "tool_result": console.log(`  ← ${event.tool}: ${short(event.result)}`); break;
    case "x402": console.log(`     x402 ${event.step.padEnd(8)} ${short(event.detail, 160)}`); break;
    case "notify_user": console.log(`🔔 ${event.message}`); break;
    case "run_finished": console.log(`\n✔ ${event.summary}\n`); break;
    case "error": console.log(`✖ ${event.message}`); break;
  }
}
