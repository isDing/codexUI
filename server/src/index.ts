import http from "node:http";
import { createApp, createWebSocketHandler } from "./api.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { CodexService } from "./codex-service.js";

const config = loadConfig();
const db = new AppDatabase(config.dataDir);
const service = new CodexService(config, db);
const app = createApp(config, db, service);
const server = http.createServer(app);
const websocket = createWebSocketHandler(config, db, service);

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }
  websocket.handleUpgrade(request, socket, head);
});

server.listen(config.port, config.host, () => {
  console.log(`Codex UI listening on http://${config.host}:${config.port}`);
  void service.start().catch((error) => console.error("Codex app-server startup failed:", error));
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}, shutting down`);
  for (const client of websocket.wss.clients) client.close(1001, "服务器关闭");
  websocket.wss.close();
  await service.stop();
  db.close();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  server.closeAllConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
