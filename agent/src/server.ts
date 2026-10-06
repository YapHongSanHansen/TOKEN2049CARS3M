import { loadGatewayConfig } from "./config.js";
import { createGateway } from "./gateway.js";

const config = loadGatewayConfig();
const { app } = createGateway(config);
app.listen(config.port, () => {
  console.log(`CARSEM gateway  ${config.publicUrl}  (${config.mode}, brain ${config.openai.apiKey ? `openai ${config.openai.model || "(set OPENAI_MODEL)"}` : "scripted"})`);
  console.log(`MCP             ${config.publicUrl}/mcp`);
});
