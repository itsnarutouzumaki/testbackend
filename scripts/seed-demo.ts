import "dotenv/config";
import { loadConfig } from "../src/config";
import { JsonStoreRepository } from "../src/repositories/json-store";
import { createDemoStore } from "../src/services/demo-seed";

async function main() {
  const config = loadConfig();
  if (config.nodeEnv === "production") throw new Error("Refusing to seed demo data when NODE_ENV=production.");
  const repository = new JsonStoreRepository(config.storePath, async () => createDemoStore(config));
  await repository.replace(await createDemoStore(config));
  console.log(`Demo data written to ${config.storePath}. This overwrites existing JSON data; back it up first.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
