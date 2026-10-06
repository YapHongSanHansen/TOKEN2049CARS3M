import { MASUMI_REGISTRY_POLICY_ID } from "@x402/cardano";
import type { Config } from "../config.js";
import type { AgentRow } from "./users.js";

/**
 * The lender's identity check. An agent registered with a Masumi registry id
 * (the registry NFT's asset id) must hold a live registry entry on preprod.
 * Agents without one are identified only by their CARSEM registration.
 */
export async function verifyAgentIdentity(config: Config, agent: AgentRow): Promise<{ ok: true; did: string } | { ok: false; reason: string }> {
  if (!agent.masumi_agent_id) return { ok: true, did: agent.did };
  if (!agent.masumi_agent_id.startsWith(MASUMI_REGISTRY_POLICY_ID)) return { ok: false, reason: "not a Masumi V2 registry asset" };
  if (config.mode !== "preprod") return { ok: true, did: agent.did };
  const { baseUrl, projectId } = config.preprod.blockfrost;
  const response = await fetch(`${baseUrl}/assets/${agent.masumi_agent_id}`, { headers: { project_id: projectId }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return { ok: false, reason: "Masumi registry entry not found on preprod" };
  if (!response.ok) return { ok: false, reason: `Blockfrost returned ${response.status}` };
  const asset = await response.json() as { quantity: string };
  return asset.quantity === "1" ? { ok: true, did: agent.did } : { ok: false, reason: "Masumi registry entry was burned" };
}
