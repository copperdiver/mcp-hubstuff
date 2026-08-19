import "dotenv/config";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./server.js";

const config = loadConfig();
const app = createHttpApp(config);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Hubstaff MCP listening on port ${config.port}`);
});
