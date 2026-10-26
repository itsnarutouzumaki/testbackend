import "dotenv/config";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { loadConfig } from "../src/config";
import { JsonStoreRepository } from "../src/repositories/json-store";
import { createEmptyStore } from "../src/services/demo-seed";
import { makeId, normalizeEmail } from "../src/utils/ids";

const input = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72)
});

async function main() {
  const config = loadConfig();
  const parsed = input.safeParse({
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    name: process.env.BOOTSTRAP_ADMIN_NAME,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD
  });
  if (!parsed.success) throw new Error("Set BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME and a strong BOOTSTRAP_ADMIN_PASSWORD in .env before running this command.");
  const repository = new JsonStoreRepository(config.storePath, createEmptyStore);
  await repository.initialize();
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await repository.mutate((store) => {
    const email = normalizeEmail(parsed.data.email);
    if (store.users.some((user) => user.role === "admin")) throw new Error("An administrator already exists in this store. Refusing to create another bootstrap admin.");
    if (store.users.some((user) => user.email === email)) throw new Error("This email is already used by another account.");
    store.users.push({
      id: makeId("admin"), role: "admin", fullName: parsed.data.name, email, mobileNumber: "",
      language: "en", passwordHash, tokenVersion: 0, isActive: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  });
  console.log(`Administrator created for ${normalizeEmail(parsed.data.email)}. Remove BOOTSTRAP_ADMIN_PASSWORD from .env when finished.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
