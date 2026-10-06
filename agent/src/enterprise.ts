/**
 * npm run enterprise:buy -- [--enterprise eBay] [--bundle <bundle id>]
 * An enterprise buys a redacted chat bundle over x402. Proceeds repay the loan
 * the bundle secures (or are CARSEM's recovery after a default).
 */
import { buyBundle, enterpriseBalance } from "./buyers.js";
import { loadGatewayConfig } from "./config.js";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const enterprise = option("enterprise") ?? "eBay";
const config = loadGatewayConfig();

try {
  const result = await buyBundle(config, {
    enterprise, bundleId: option("bundle"),
    onStep: step => console.log(`  x402 ${step.step.padEnd(8)} ${JSON.stringify(step.detail).slice(0, 160)}`),
  });
  console.log(`\n${enterprise} bought bundle ${result.bundleId} [${result.reason}] for ${result.price} tUSDM (tx ${result.payment.tx})`);
  console.log(`received ${result.messages.length} redacted messages, e.g.\n  ${result.messages.slice(0, 3).join("\n  ")}`);
  if (result.loan) console.log(`loan ${result.loan.id}: ${result.loan.before.status} ${result.loan.before.outstanding} -> ${result.loan.after.status} ${result.loan.after.outstanding} tUSDM outstanding`);
  const balance = await enterpriseBalance(config, enterprise);
  console.log(`${enterprise} balance ${balance.tUSDM} tUSDM`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
