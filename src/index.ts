import "dotenv/config";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./server.js";
import { logDiagnostic } from "./diagnostics.js";

const config = loadConfig();
const app = createHttpApp(config);

app.listen(config.port, "0.0.0.0", () => {
  logDiagnostic("server.started", { port: config.port });
});
