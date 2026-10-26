import "dotenv/config";
import path from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { JsonStoreRepository } from "./repositories/json-store";
import { createDemoStore, createEmptyStore } from "./services/demo-seed";

async function main() {
  const config = loadConfig();
  const repository = new JsonStoreRepository(config.storePath, async () => {
    if (config.enableDemoData && config.nodeEnv !== "production") {
      console.warn("Initializing local demo data. Do not use demo data or demo passwords in production.");
      return createDemoStore(config);
    }
    return createEmptyStore();
  });
  await repository.initialize();
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.resolve(config.fileStorageDir), { recursive: true }));
  const app = createApp({ config, repository });
  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`Guardian School API listening on http://0.0.0.0:${config.port}`);
    console.log(`Health check: http://localhost:${config.port}/health`);
    if (config.enableDemoData && config.nodeEnv !== "production") console.log("Development demo accounts are enabled; see README.md for credentials.");
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received. Closing HTTP server...`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start Guardian School API:", error);
  process.exit(1);
});
