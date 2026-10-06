import type { Config } from "../config.js";
import { HttpError } from "./errors.js";

/** carsem-api → agent gateway (custody). The gateway creates and holds each user's agent wallet. */
export class GatewayClient {
  constructor(private readonly config: Config) {}

  async createWallet(userId: string): Promise<{ address: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.config.gatewayUrl}/internal/wallets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Service-Token": this.config.serviceToken },
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HttpError(502, `The agent gateway is not reachable at ${this.config.gatewayUrl}. Start it with npm run gateway.`);
    }
    const body = await response.json().catch(() => ({})) as { address?: string; error?: string };
    if (!response.ok || !body.address) throw new HttpError(502, `The agent gateway could not create a wallet: ${body.error ?? response.status}`);
    return { address: body.address };
  }
}
