/**
 * npm run tool -- <tool name> ['{"json":"input"}']      (npm run tool -- list)
 * Calls one CARSEM tool through the gateway, like curl POST /v1/tools/<name>.
 */
import { loadGatewayConfig } from "./config.js";

const [name = "list", input = "{}"] = process.argv.slice(2);
const config = loadGatewayConfig();
const key = process.env.CARSEM_KEY?.trim() ?? "";
const response = name === "list"
  ? await fetch(`${config.publicUrl}/v1/tools`)
  : await fetch(`${config.publicUrl}/v1/tools/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: input });
const body = await response.json();
console.log(JSON.stringify(name === "list" ? body.map((t: { name: string; description: string }) => `${t.name}: ${t.description.split(". ")[0]}`) : body, null, 2));
if (!response.ok) process.exitCode = 1;
