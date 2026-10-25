import "dotenv/config";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./server.js";
import { logDiagnostic } from "./diagnostics.js";
import { JsonEventStore } from "./events.js";
import { EventMonitor } from "./event-monitor.js";
import { HubstaffClient } from "./hubstaff-client.js";

const config = loadConfig();
const client = new HubstaffClient(config);
let events: { store: JsonEventStore; monitor: EventMonitor } | undefined;
if (config.events.enabled) {
  const store = new JsonEventStore(config.events.statePath, { retention: config.events.retention });
  await store.load();
  events = { store, monitor: new EventMonitor(config.events, client, store) };
}
const app = createHttpApp(config, events, client);

const http = app.listen(config.port, "0.0.0.0", () => {
  logDiagnostic("server.started", { port: config.port });
  events?.monitor.start();
});

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  events?.monitor.stop();
  void app.locals.close().finally(() => http.close());
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
